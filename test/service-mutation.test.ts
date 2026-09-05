import { PassThrough } from "node:stream";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildProject, getDirectorySnapshotCapability, parseAssetTomlV2, serializeSvgV2 } from "../src/index.js";
import { StudioServer } from "../src/service-protocol/server.js";
import { makeTempDir, readRepoFile, unwrap } from "./helpers.js";

type Message = Record<string, any>;

const roots: string[] = [];
const services: ServiceHarness[] = [];
const nativeAvailable = getDirectorySnapshotCapability(realpathSync(tmpdir())).supported;

function temp(prefix = "tfsb-service-mutation-"): string {
  const root = realpathSync(makeTempDir(prefix));
  roots.push(root);
  return root;
}

function assetToml(id: string, title = "Synthetic"): string {
  return `schema_version = 1
id = ${JSON.stringify(id)}
filename = ${JSON.stringify(`${id}.svg`)}

[canvas]
view_box = "0 0 10 10"

[accessibility]
title = ${JSON.stringify(title)}
title_id = "title"
description = "Synthetic."
description_id = "description"

[[elements]]
type = "path"
d = "M 0 0 H 10 V 10 Z"
`;
}

function createProject(root: string, options: { readonly install?: boolean; readonly schema?: 1 | 2 } = {}): void {
  mkdirSync(join(root, ".tfsb/assets"), { recursive: true });
  const schema = options.schema ?? 1;
  const install = options.install === true
    ? '\n[[install]]\nasset = "alpha"\ndestinations = ["installed/alpha.svg"]\n'
    : "";
  writeFileSync(
    join(root, ".tfsb/project.toml"),
    `schema_version = ${schema}\nname = "Service mutation project"\n\n[build]\ndirectory = "dist"\n${install}`,
  );
  writeFileSync(join(root, ".tfsb/assets/alpha.toml"), assetToml("alpha"));
}

function archivePath(base: string, name = "source.zip"): string {
  const model = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml")));
  const svg = unwrap(serializeSvgV2(model.svg));
  const path = join(base, name);
  writeFileSync(path, Buffer.from(zipSync({ "alpha.svg": Buffer.from(svg) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") })));
  return path;
}

function expectError(response: Message, expected: string): void {
  expect(response).toMatchObject({ error: { data: { code: expected } } });
}

function planResult(response: Message, method: string): Message {
  expect(response).toMatchObject({
    result: {
      method,
      planToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      planDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      expiresInMs: 600_000,
    },
  });
  return response.result as Message;
}

function progressFor(harness: ServiceHarness, requestId: string): Message[] {
  return harness.allMessages.filter((value) => value.method === "$/progress" && value.params?.requestId === requestId);
}

function assertNoPrivateValue(value: unknown, forbidden: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const item of forbidden) expect(serialized).not.toContain(item);
}

function transactionResidue(root: string): string[] {
  return readdirSync(root).filter((name) => /^\.tfsb(?:\.lock|-stage-|-backup-)/.test(name)).sort();
}

class ServiceHarness {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly error = new PassThrough();
  readonly messages: Message[] = [];
  readonly allMessages: Message[] = [];
  readonly server: StudioServer;
  stderr = "";
  nonce: string | undefined;
  closed = false;
  onProtocolMessage: ((message: Message) => void) | undefined;
  private pending = "";
  private exitCode: number | undefined;
  private exitWaiters: (() => void)[] = [];
  private responseWaiters: (() => void)[] = [];

  constructor() {
    this.output.on("data", (chunk: Buffer) => {
      this.pending += chunk.toString("utf8");
      for (;;) {
        const newline = this.pending.indexOf("\n");
        if (newline < 0) break;
        const line = this.pending.slice(0, newline);
        this.pending = this.pending.slice(newline + 1);
        if (line.length === 0) continue;
        const message = JSON.parse(line) as Message;
        this.messages.push(message);
        this.allMessages.push(message);
        this.onProtocolMessage?.(message);
        this.responseWaiters.splice(0).forEach((resolve) => resolve());
      }
    });
    this.error.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf8"); });
    this.server = new StudioServer({
      input: this.input,
      output: this.output,
      error: this.error,
      onExitCode: (exitCode) => {
        this.exitCode = exitCode;
        this.exitWaiters.splice(0).forEach((resolve) => resolve());
      },
    });
    this.server.start();
  }

  send(value: unknown): void {
    if (this.closed) throw new Error("Service harness is closed.");
    this.input.write(`${JSON.stringify(value)}\n`);
  }

  async response(id: string | number): Promise<Message> {
    const found = (): Message | undefined => {
      const index = this.messages.findIndex((value) => value.id === id);
      if (index < 0) return undefined;
      return this.messages.splice(index, 1)[0];
    };
    const existing = found();
    if (existing !== undefined) return existing;
    const deadline = Date.now() + 15_000;
    return new Promise<Message>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const onMessage = (): void => {
        const next = found();
        if (next === undefined) {
          this.responseWaiters.push(onMessage);
          return;
        }
        clearTimeout(timer);
        resolve(next);
      };
      timer = setTimeout(() => {
        const index = this.responseWaiters.indexOf(onMessage);
        if (index >= 0) this.responseWaiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${String(id)}`));
      }, Math.max(1, deadline - Date.now()));
      this.responseWaiters.push(onMessage);
    });
  }

  async call(id: string, method: string, params: Record<string, unknown>): Promise<Message> {
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.response(id);
  }

  async initialize(progress = false): Promise<string> {
    const response = await this.call("initialize", "initialize", {
      protocol: "tfsb.studio",
      minVersion: "1.0",
      maxVersion: "1.0",
      client: { name: "service-mutation-test", version: "1" },
      capabilities: { progress, cancellation: true },
    });
    expect(response.error).toBeUndefined();
    this.nonce = response.result.sessionNonce as string;
    this.send({ jsonrpc: "2.0", method: "initialized", params: { sessionNonce: this.nonce } });
    return this.nonce;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const nonce = this.nonce;
    if (nonce !== undefined && this.exitCode === undefined) {
      try {
        expect(await this.call("shutdown", "shutdown", { sessionNonce: nonce })).toMatchObject({ result: null });
        this.send({ jsonrpc: "2.0", method: "exit", params: {} });
      } catch {
        this.input.end();
      }
    } else {
      this.input.end();
    }
    if (this.exitCode === undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        this.exitWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    this.closed = true;
  }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Studio mutation service boundary", () => {
  it("cancels planning at a bounded checkpoint without registering authority", { timeout: 30_000 }, async () => {
    const root = temp();
    createProject(root);
    const before = readFileSync(join(root, ".tfsb/assets/alpha.toml"), "utf8");
    const service = new ServiceHarness(); services.push(service);
    const nonce = await service.initialize(true);
    const opened = await service.call("cancel-plan-open", "project.open", { sessionNonce: nonce, path: root });
    const projectHandle = opened.result.projectHandle as string;
    let cancellationSent = false;
    service.onProtocolMessage = (message) => {
      if (message.method !== "$/progress" || message.params?.requestId !== "cancel-plan" || message.params.stage !== "plan") return;
      service.onProtocolMessage = undefined;
      cancellationSent = true;
      service.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { sessionNonce: nonce, id: "cancel-plan" } });
    };

    expectError(await service.call("cancel-plan", "asset.edit.plan", {
      sessionNonce: nonce, projectHandle, assetId: "alpha", proposedToml: assetToml("alpha", "Cancelled planning"),
    }), "REQUEST_CANCELLED");
    expect(cancellationSent).toBe(true);
    expect(progressFor(service, "cancel-plan").map((item) => item.params.stage)).not.toContain("ready");
    expect(readFileSync(join(root, ".tfsb/assets/alpha.toml"), "utf8")).toBe(before);
    expect(transactionResidue(root)).toEqual([]);

    const replacement = planResult(await service.call("replacement-plan", "asset.edit.plan", {
      sessionNonce: nonce, projectHandle, assetId: "alpha", proposedToml: assetToml("alpha", "Replacement"),
    }), "asset.edit.plan");
    expect(await service.call("replacement-discard", "plan.discard", {
      sessionNonce: nonce, planToken: replacement.planToken,
    })).toMatchObject({ result: { discarded: true } });
  });

  it("consumes a pre-promotion cancellation and removes transaction residue", { timeout: 30_000 }, async () => {
    const root = temp();
    createProject(root);
    const before = readFileSync(join(root, ".tfsb/assets/alpha.toml"), "utf8");
    const service = new ServiceHarness(); services.push(service);
    const nonce = await service.initialize(true);
    const opened = await service.call("cancel-apply-open", "project.open", { sessionNonce: nonce, path: root });
    const projectHandle = opened.result.projectHandle as string;
    const plan = planResult(await service.call("cancel-apply-plan", "asset.edit.plan", {
      sessionNonce: nonce, projectHandle, assetId: "alpha", proposedToml: assetToml("alpha", "Cancelled apply"),
    }), "asset.edit.plan");
    let cancellationSent = false;
    service.onProtocolMessage = (message) => {
      if (message.method !== "$/progress" || message.params?.requestId !== "cancel-apply" || message.params.stage !== "staging") return;
      service.onProtocolMessage = undefined;
      cancellationSent = true;
      service.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { sessionNonce: nonce, id: "cancel-apply" } });
    };

    expectError(await service.call("cancel-apply", "plan.apply", {
      sessionNonce: nonce, planToken: plan.planToken, expectedPlanDigest: plan.planDigest,
    }), "REQUEST_CANCELLED");
    expect(cancellationSent).toBe(true);
    const stages = progressFor(service, "cancel-apply").map((item) => item.params.stage);
    expect(stages).toEqual(expect.arrayContaining(["revalidate", "waiting-lock", "staging", "cleanup"]));
    expect(stages).not.toContain("promoting");
    expect(stages).not.toContain("complete");
    expectError(await service.call("cancel-apply-reuse", "plan.apply", {
      sessionNonce: nonce, planToken: plan.planToken, expectedPlanDigest: plan.planDigest,
    }), "PLAN_TOKEN_INVALID");
    expect(readFileSync(join(root, ".tfsb/assets/alpha.toml"), "utf8")).toBe(before);
    expect(transactionResidue(root)).toEqual([]);
  });

  it("defers cancellation after promotion starts until the transaction completes", { timeout: 30_000 }, async () => {
    const root = temp();
    createProject(root);
    const service = new ServiceHarness(); services.push(service);
    const nonce = await service.initialize(true);
    const opened = await service.call("deferred-open", "project.open", { sessionNonce: nonce, path: root });
    const projectHandle = opened.result.projectHandle as string;
    const plan = planResult(await service.call("deferred-plan", "asset.edit.plan", {
      sessionNonce: nonce, projectHandle, assetId: "alpha", proposedToml: assetToml("alpha", "Deferred cancellation"),
    }), "asset.edit.plan");
    let cancellationSent = false;
    service.onProtocolMessage = (message) => {
      if (message.method !== "$/progress" || message.params?.requestId !== "deferred-apply" || message.params.stage !== "promoting") return;
      service.onProtocolMessage = undefined;
      cancellationSent = true;
      service.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { sessionNonce: nonce, id: "deferred-apply" } });
    };

    expect(await service.call("deferred-apply", "plan.apply", {
      sessionNonce: nonce, planToken: plan.planToken, expectedPlanDigest: plan.planDigest,
    })).toMatchObject({ result: { applied: true, method: "asset.edit.plan" } });
    expect(cancellationSent).toBe(true);
    const stages = progressFor(service, "deferred-apply").map((item) => item.params.stage);
    expect(stages).toEqual(expect.arrayContaining(["staging", "promoting", "cleanup", "complete"]));
    expect(readFileSync(join(root, ".tfsb/assets/alpha.toml"), "utf8")).toContain('title = "Deferred cancellation"');
    expectError(await service.call("deferred-reuse", "plan.apply", {
      sessionNonce: nonce, planToken: plan.planToken, expectedPlanDigest: plan.planDigest,
    }), "PLAN_TOKEN_INVALID");
    expect(transactionResidue(root)).toEqual([]);
  });

  it("applies an authentic asset edit and enforces digest, one-use, discard, and stale-token rules", { timeout: 45_000 }, async () => {
    const root = temp();
    createProject(root);
    const service = new ServiceHarness(); services.push(service);
    const nonce = await service.initialize(true);
    const opened = await service.call("open", "project.open", { sessionNonce: nonce, path: root });
    const projectHandle = opened.result.projectHandle as string;
    const proposal = assetToml("alpha", "Edited");

    const planned = await service.call("edit-plan", "asset.edit.plan", {
      sessionNonce: nonce, projectHandle, assetId: "alpha", proposedToml: proposal,
    });
    const plan = planResult(planned, "asset.edit.plan");
    expect(plan.summary).toMatchObject({ assetId: "alpha", affectedCanonicalPath: ".tfsb/assets/alpha.toml", changed: true });
    // The token is deliberately returned by the plan wrapper; it must not
    // appear in the digest, progress, or subsequent error payloads.
    assertNoPrivateValue(plan, [root]);
    expect(plan.planDigest).not.toContain(plan.planToken);
    const plannedProgress = progressFor(service, "edit-plan");
    expect(plannedProgress.map((item) => item.params.stage)).toEqual(["validate", "snapshot", "plan", "ready"]);
    assertNoPrivateValue(plannedProgress, [root, plan.planToken]);

    const wrongDigest = `sha256:${"0".repeat(64)}`;
    const mismatch = await service.call("digest-mismatch", "plan.apply", {
      sessionNonce: nonce, planToken: plan.planToken, expectedPlanDigest: wrongDigest,
    });
    expectError(mismatch, "PLAN_DIGEST_MISMATCH");
    assertNoPrivateValue(mismatch, [root, plan.planToken]);

    const applied = await service.call("edit-apply", "plan.apply", {
      sessionNonce: nonce, planToken: plan.planToken, expectedPlanDigest: plan.planDigest,
    });
    expect(applied).toMatchObject({ result: { applied: true, method: "asset.edit.plan" } });
    expect(readFileSync(join(root, ".tfsb/assets/alpha.toml"), "utf8")).toContain('title = "Edited"');
    const applyStages = progressFor(service, "edit-apply").map((item) => item.params.stage);
    const applyOrder = ["revalidate", "waiting-lock", "staging", "promoting", "cleanup", "complete"];
    expect(applyStages).toEqual([...applyStages].sort((left, right) => applyOrder.indexOf(left) - applyOrder.indexOf(right)));
    expect(applyStages).toEqual(expect.arrayContaining(applyOrder));
    assertNoPrivateValue(progressFor(service, "edit-apply"), [root, plan.planToken]);

    const reused = await service.call("edit-reuse", "plan.apply", {
      sessionNonce: nonce, planToken: plan.planToken, expectedPlanDigest: plan.planDigest,
    });
    expectError(reused, "PLAN_TOKEN_INVALID");

    const discardPlan = planResult(await service.call("discard-plan", "asset.edit.plan", {
      sessionNonce: nonce, projectHandle, assetId: "alpha", proposedToml: assetToml("alpha", "Discarded"),
    }), "asset.edit.plan");
    expect(await service.call("discard", "plan.discard", { sessionNonce: nonce, planToken: discardPlan.planToken })).toMatchObject({ result: { discarded: true } });
    const discardedApply = await service.call("discarded-apply", "plan.apply", {
      sessionNonce: nonce, planToken: discardPlan.planToken, expectedPlanDigest: discardPlan.planDigest,
    });
    expectError(discardedApply, "PLAN_TOKEN_INVALID");

    const stalePlan = planResult(await service.call("stale-plan", "asset.edit.plan", {
      sessionNonce: nonce, projectHandle, assetId: "alpha", proposedToml: assetToml("alpha", "Stale proposal"),
    }), "asset.edit.plan");
    await writeFile(join(root, ".tfsb/assets/alpha.toml"), assetToml("alpha", "External drift"));
    const stale = await service.call("stale-apply", "plan.apply", {
      sessionNonce: nonce, planToken: stalePlan.planToken, expectedPlanDigest: stalePlan.planDigest,
    });
    expectError(stale, "PLAN_STALE");
    assertNoPrivateValue(stale, [root, stalePlan.planToken]);
    const consumed = await service.call("stale-reuse", "plan.apply", {
      sessionNonce: nonce, planToken: stalePlan.planToken, expectedPlanDigest: stalePlan.planDigest,
    });
    expectError(consumed, "PLAN_TOKEN_INVALID");
    expect(service.stderr).toBe("");
  });

  it("confines import-target handles and retains archive import/reconcile authority without leaking paths or source bytes", { timeout: 60_000 }, async () => {
    const base = temp();
    const target = join(base, "target");
    mkdirSync(target);
    const archive = archivePath(base);
    const sourceBytes = readFileSync(archive);
    const service = new ServiceHarness(); services.push(service);
    const nonce = await service.initialize(true);

    const targetOpened = await service.call("target", "project.open", { sessionNonce: nonce, path: target, mode: "import-target" });
    const targetHandle = targetOpened.result.projectHandle as string;
    expect(targetOpened).toMatchObject({ result: { rootKind: "project", state: "uninitialized" } });
    const targetRead = await service.call("target-read", "project.list", { sessionNonce: nonce, projectHandle: targetHandle });
    expectError(targetRead, "ROOT_HANDLE_INVALID");

    const sourceOpened = await service.call("source", "source.open", { sessionNonce: nonce, path: archive });
    const sourceHandle = sourceOpened.result.sourceHandle as string;
    expect(sourceOpened).toMatchObject({ result: { rootKind: "source", sourceKind: "archive" } });
    const imported = planResult(await service.call("import-plan", "project.import.plan", {
      sessionNonce: nonce, projectHandle: targetHandle, sourceHandle, schemaVersion: 2,
    }), "project.import.plan");
    expect(imported.summary).toMatchObject({ sourceKind: "archive", schemaVersion: 2, willInitialize: true });
    assertNoPrivateValue(imported, [target, archive, sourceBytes.toString("base64")]);
    assertNoPrivateValue(progressFor(service, "import-plan"), [target, archive, sourceBytes.toString("base64")]);

    const importedApply = await service.call("import-apply", "plan.apply", {
      sessionNonce: nonce, planToken: imported.planToken, expectedPlanDigest: imported.planDigest,
    });
    expect(importedApply).toMatchObject({ result: { applied: true, method: "project.import.plan" } });
    expect(readFileSync(join(target, ".tfsb/project.toml"), "utf8")).toContain("schema_version = 2");
    assertNoPrivateValue(progressFor(service, "import-apply"), [target, archive, sourceBytes.toString("base64")]);

    const initialized = await service.call("initialized-target", "project.open", { sessionNonce: nonce, path: target });
    const projectHandle = initialized.result.projectHandle as string;
    const reconcile = planResult(await service.call("reconcile-plan", "project.reconcile.plan", {
      sessionNonce: nonce, projectHandle, sourceHandle,
    }), "project.reconcile.plan");
    expect(reconcile.summary).toMatchObject({ sourceKind: "archive" });
    assertNoPrivateValue(reconcile, [target, archive, sourceBytes.toString("base64")]);
    expect(await service.call("reconcile-apply", "plan.apply", {
      sessionNonce: nonce, planToken: reconcile.planToken, expectedPlanDigest: reconcile.planDigest,
    })).toMatchObject({ result: { applied: true, method: "project.reconcile.plan" } });

    const staleAuxTarget = join(base, "stale-aux-target");
    mkdirSync(staleAuxTarget);
    const normalizationMap = join(base, "normalization-map.toml");
    writeFileSync(normalizationMap, "schema_version = 1\n");
    const staleTargetHandle = (await service.call("stale-aux-target-open", "project.open", {
      sessionNonce: nonce, path: staleAuxTarget, mode: "import-target",
    })).result.projectHandle as string;
    const normalizationMapHandle = (await service.call("normalization-map-open", "source.open", {
      sessionNonce: nonce, path: normalizationMap, purpose: "normalization-map",
    })).result.sourceHandle as string;
    const auxPlan = planResult(await service.call("stale-aux-plan", "project.import.plan", {
      sessionNonce: nonce,
      projectHandle: staleTargetHandle,
      sourceHandle,
      schemaVersion: 2,
      normalization: "exact-common",
      normalizationMapHandle,
    }), "project.import.plan");
    writeFileSync(normalizationMap, "schema_version = 1\n# changed authority bytes\n");
    expectError(await service.call("stale-aux-apply", "plan.apply", {
      sessionNonce: nonce, planToken: auxPlan.planToken, expectedPlanDigest: auxPlan.planDigest,
    }), "PLAN_STALE");
    expectError(await service.call("stale-aux-reuse", "plan.apply", {
      sessionNonce: nonce, planToken: auxPlan.planToken, expectedPlanDigest: auxPlan.planDigest,
    }), "PLAN_TOKEN_INVALID");

    const staleTarget = await service.call("target-reopen", "project.open", { sessionNonce: nonce, path: target, mode: "import-target" });
    expectError(staleTarget, "ROOT_INVALID");
    const allProtocolOutput = JSON.stringify(service.allMessages);
    expect(allProtocolOutput).not.toContain(target);
    expect(allProtocolOutput).not.toContain(archive);
    expect(allProtocolOutput).not.toContain(sourceBytes.toString("base64"));
    expect(service.stderr).toBe("");
  });

  it("dispatches the remaining project-owned planners through opaque handles", { timeout: 90_000 }, async () => {
    const base = temp();
    const migrateRoot = join(base, "migrate"); mkdirSync(migrateRoot); createProject(migrateRoot, { schema: 1 });
    const fmtRoot = join(base, "fmt"); mkdirSync(fmtRoot); createProject(fmtRoot, { schema: 1 });
    const buildRoot = join(base, "build"); mkdirSync(buildRoot); createProject(buildRoot, { schema: 1 });
    const installRoot = join(base, "install"); mkdirSync(installRoot); createProject(installRoot, { install: true, schema: 1 });
    await buildProject(installRoot);
    const previewRoot = join(base, "preview"); mkdirSync(previewRoot); createProject(previewRoot, { schema: 1 });

    const service = new ServiceHarness(); services.push(service);
    const nonce = await service.initialize(false);
    const handles = new Map<string, string>();
    for (const [label, root] of [["migrate", migrateRoot], ["fmt", fmtRoot], ["build", buildRoot], ["install", installRoot], ["preview", previewRoot]] as const) {
      const opened = await service.call(`open-${label}`, "project.open", { sessionNonce: nonce, path: root });
      handles.set(label, opened.result.projectHandle as string);
    }
    const methods = [
      ["project.migrate.plan", "migrate", { targetSchemaVersion: 2 }],
      ["project.fmt.plan", "fmt", {}],
      ["project.build.plan", "build", {}],
      ["project.install.plan", "install", {}],
      ["preview.plan", "preview", {}],
    ] as const;
    for (const [method, label, extra] of methods) {
      const plan = planResult(await service.call(`plan-${label}`, method, {
        sessionNonce: nonce, projectHandle: handles.get(label), ...extra,
      }), method);
      const resultText = JSON.stringify(plan);
      expect(resultText).not.toContain(base);
      expect(resultText).not.toContain("/tmp/");
      expect(await service.call(`apply-${label}`, "plan.apply", {
        sessionNonce: nonce, planToken: plan.planToken, expectedPlanDigest: plan.planDigest,
      })).toMatchObject({ result: { applied: true, method } });
    }
    expect(readFileSync(join(migrateRoot, ".tfsb/project.toml"), "utf8")).toContain("schema_version = 2");
    expect(readFileSync(join(buildRoot, "dist/alpha.svg"), "utf8")).toContain("<svg");
    expect(readFileSync(join(installRoot, "installed/alpha.svg"), "utf8")).toContain("<svg");
    expect(readFileSync(join(previewRoot, ".tfsb-preview/index.html"), "utf8")).toContain("<!doctype html>");
    expect(service.stderr).toBe("");
  });

  it.runIf(nativeAvailable)("applies directory import and reconcile with source-contained and typed map authority", { timeout: 90_000 }, async () => {
    const base = temp();
    const source = join(base, "source");
    const target = join(base, "target");
    mkdirSync(join(source, "icons"), { recursive: true });
    mkdirSync(target);
    const model = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml")));
    writeFileSync(join(source, "icons/direct.svg"), unwrap(serializeSvgV2(model.svg)));
    const mapPath = join(source, ".tfsb-source-map.toml");
    writeFileSync(mapPath, `schema_version = 1
source_root = "."

[[collection]]
id = "icons"
name = "Icons"
root = "."
identity = "basename"
prefix = ""
include_paths = []
include_trees = ["icons"]
exclude_paths = []
exclude_trees = []
`);

    const service = new ServiceHarness(); services.push(service);
    const nonce = await service.initialize(false);
    const targetHandle = (await service.call("directory-target", "project.open", {
      sessionNonce: nonce, path: target, mode: "import-target",
    })).result.projectHandle as string;
    const sourceHandle = (await service.call("directory-source", "source.open", {
      sessionNonce: nonce, path: source,
    })).result.sourceHandle as string;
    const sourceMapHandle = (await service.call("directory-map", "source.open", {
      sessionNonce: nonce, path: mapPath, purpose: "source-map",
    })).result.sourceHandle as string;

    const importPlan = planResult(await service.call("directory-import-plan", "project.import.plan", {
      sessionNonce: nonce, projectHandle: targetHandle, sourceHandle, schemaVersion: 2, collections: ["icons"],
    }), "project.import.plan");
    expect(importPlan.summary).toMatchObject({ sourceKind: "directory", willInitialize: true });
    expect(await service.call("directory-import-apply", "plan.apply", {
      sessionNonce: nonce, planToken: importPlan.planToken, expectedPlanDigest: importPlan.planDigest,
    })).toMatchObject({ result: { applied: true, method: "project.import.plan" } });

    const projectHandle = (await service.call("directory-project", "project.open", {
      sessionNonce: nonce, path: target,
    })).result.projectHandle as string;
    const reconcilePlan = planResult(await service.call("directory-reconcile-plan", "project.reconcile.plan", {
      sessionNonce: nonce,
      projectHandle,
      sourceHandle,
      collections: ["icons"],
      sourceMapAuthority: { kind: "handle", sourceMapHandle },
    }), "project.reconcile.plan");
    expect(reconcilePlan.summary).toMatchObject({ sourceKind: "directory", blocked: false });
    expect(await service.call("directory-reconcile-apply", "plan.apply", {
      sessionNonce: nonce, planToken: reconcilePlan.planToken, expectedPlanDigest: reconcilePlan.planDigest,
    })).toMatchObject({ result: { applied: true, method: "project.reconcile.plan" } });
    assertNoPrivateValue(service.allMessages, [source, target, mapPath]);
    expect(service.stderr).toBe("");
  });
});
