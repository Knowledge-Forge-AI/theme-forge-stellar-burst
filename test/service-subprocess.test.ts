import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

import { listWorkspace } from "../src/workspace-list.js";
import { makeTempDir, readRepoFile, repoPath } from "./helpers.js";

const roots: string[] = [];
function temp(): string { const root = realpathSync(makeTempDir("tfsb-service-")); roots.push(root); return root; }

function asset(id: string): string {
  return `schema_version = 1\nid = ${JSON.stringify(id)}\nfilename = ${JSON.stringify(`${id}.svg`)}\n\n[canvas]\nview_box = "0 0 10 10"\n\n[accessibility]\ntitle = "Synthetic"\ntitle_id = "title"\ndescription = "Synthetic."\ndescription_id = "description"\n\n[[elements]]\ntype = "path"\nd = "M 0 0 H 10 V 10 Z"\n`;
}

function project(root: string, ids: readonly string[]): void {
  mkdirSync(join(root, ".tfsb/assets"), { recursive: true });
  writeFileSync(join(root, ".tfsb/project.toml"), 'schema_version = 1\nname = "Service project"\n\n[build]\ndirectory = "dist"\n');
  for (const id of ids) writeFileSync(join(root, ".tfsb/assets", `${id}.toml`), asset(id));
}

function snapshot(root: string, prefix = ""): string[] {
  const values: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) values.push(...snapshot(root, relative));
    else values.push(`${relative}:${createHash("sha256").update(readFileSync(join(root, relative))).digest("hex")}`);
  }
  return values;
}

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: unknown[] = [];
  stderr = "";
  readonly #waiters: (() => void)[] = [];

  constructor() {
    this.child = spawn(process.execPath, [repoPath("dist/service-protocol/server-cli.js")], { stdio: "pipe" });
    createInterface({ input: this.child.stdout }).on("line", (line) => { this.messages.push(JSON.parse(line)); this.#waiters.splice(0).forEach((done) => done()); });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
  }

  send(value: unknown): void { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  write(bytes: Uint8Array): void { this.child.stdin.write(bytes); }

  async response(id: string | number): Promise<any> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex((value) => typeof value === "object" && value !== null && "id" in value && (value as { id: unknown }).id === id);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${String(id)}`)), Math.max(1, deadline - Date.now()));
        this.#waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    throw new Error(`Timed out waiting for ${String(id)}`);
  }

  async initialize(progress = false): Promise<string> {
    this.send({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocol: "tfsb.studio", minVersion: "1.0", maxVersion: "1.0", client: { name: "vitest", version: "1" }, capabilities: { progress, cancellation: true } } });
    const initialized = await this.response("init");
    const nonce = initialized.result.sessionNonce as string;
    this.send({ jsonrpc: "2.0", method: "initialized", params: { sessionNonce: nonce } });
    return nonce;
  }

  async close(nonce: string): Promise<number | null> {
    this.send({ jsonrpc: "2.0", id: "shutdown", method: "shutdown", params: { sessionNonce: nonce } });
    expect(await this.response("shutdown")).toMatchObject({ result: null });
    this.send({ jsonrpc: "2.0", method: "exit", params: {} });
    this.child.stdin.end();
    return new Promise((resolve) => this.child.once("close", resolve));
  }
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("real tfsb-studio-service process", () => {
  it("runs the read-only project/workspace/source surface without changing input trees", { timeout: 30_000 }, async () => {
    const root = temp(); const projectRoot = join(root, "projects/alpha"); project(projectRoot, ["alpha", "beta"]);
    project(join(root, "projects/undeclared"), ["outside"]);
    const workspaceFile = join(root, ".tfsb-workspace.toml");
    writeFileSync(workspaceFile, 'schema_version = 1\nid = "workspace"\nname = "Workspace"\n\n[[project]]\nid = "alpha"\npath = "projects/alpha"\ncollections = ["icons"]\n');
    const source = join(root, "source"); mkdirSync(source); writeFileSync(join(source, "icon.svg"), readRepoFile("test/fixtures/tftn-icon-candidate-v1/favicon.svg"));
    const before = snapshot(root); const client = new Client(); const nonce = await client.initialize();

    client.send({ jsonrpc: "2.0", id: "po", method: "project.open", params: { sessionNonce: nonce, path: projectRoot } });
    const projectHandle = (await client.response("po")).result.projectHandle as string;
    expect(projectHandle).toMatch(/^project_[A-Za-z0-9_-]{43}$/);

    client.send({ jsonrpc: "2.0", id: "pl", method: "project.list", params: { sessionNonce: nonce, projectHandle } });
    expect(await client.response("pl")).toMatchObject({ result: { assets: [{ id: "alpha" }, { id: "beta" }] } });

    client.send({ jsonrpc: "2.0", id: "get", method: "asset.get", params: { sessionNonce: nonce, scope: { kind: "project", projectHandle, assetId: "alpha" } } });
    const got = await client.response("get");
    expect(got.result).toMatchObject({ assetId: "alpha", model: { id: "alpha" }, digests: { rawToml: expect.stringMatching(/^sha256:/), semantic: expect.stringMatching(/^sha256:/), svg: expect.stringMatching(/^sha256:/) } });
    expect(got.result.canonicalSvg).toContain("<svg");

    const canonical = readFileSync(join(projectRoot, ".tfsb/assets/alpha.toml"), "utf8");
    client.send({ jsonrpc: "2.0", id: "validate", method: "asset.validate", params: { sessionNonce: nonce, projectHandle, assetId: "alpha", toml: canonical } });
    expect(await client.response("validate")).toMatchObject({ result: { valid: true, model: { id: "alpha" } } });
    client.send({ jsonrpc: "2.0", id: "diff", method: "asset.diff", params: { sessionNonce: nonce, projectHandle, assetId: "alpha", toml: canonical.replace('title = "Synthetic"', 'title = "Changed"') } });
    expect(await client.response("diff")).toMatchObject({ result: { valid: true, different: true } });

    client.send({ jsonrpc: "2.0", id: "wo", method: "workspace.open", params: { sessionNonce: nonce, path: workspaceFile } });
    const workspaceHandle = (await client.response("wo")).result.workspaceHandle as string;
    client.send({ jsonrpc: "2.0", id: "ws", method: "workspace.status", params: { sessionNonce: nonce, workspaceHandle, mode: "discovery" } });
    expect(await client.response("ws")).toMatchObject({ result: { workspaceId: "workspace", totalProjects: 1, loadable: 1, failed: 0 } });
    client.send({ jsonrpc: "2.0", id: "wl1", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 1 } });
    const first = await client.response("wl1");
    expect(first.result.page).toMatchObject({ count: 1, items: [{ projectId: "alpha", assetId: "alpha" }] });
    client.send({ jsonrpc: "2.0", id: "wl2", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 1, cursor: first.result.page.nextCursor } });
    expect(await client.response("wl2")).toMatchObject({ result: { page: { count: 1, items: [{ assetId: "beta" }], nextCursor: null } } });
    client.send({ jsonrpc: "2.0", id: "outside", method: "asset.get", params: { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle, projectId: "undeclared", assetId: "outside" } } });
    expect(await client.response("outside")).toMatchObject({ error: { data: { code: "ROOT_HANDLE_INVALID" } } });

    client.send({ jsonrpc: "2.0", id: "so", method: "source.open", params: { sessionNonce: nonce, path: source } });
    const sourceHandle = (await client.response("so")).result.sourceHandle as string;
    client.send({ jsonrpc: "2.0", id: "sa", method: "source.analyze", params: { sessionNonce: nonce, sourceHandle, includeDetails: true, pageSize: 1 } });
    expect(await client.response("sa")).toMatchObject({ result: { sourceKind: "directory", summary: { totals: { svgFiles: 1 } }, details: { count: 1 } } });

    client.send({ jsonrpc: "2.0", id: "ps", method: "preview.status", params: { sessionNonce: nonce, projectHandle } });
    expect(await client.response("ps")).toMatchObject({ result: { status: "absent", outputIdentity: ".tfsb-preview" } });
    client.send({ jsonrpc: "2.0", id: "wrong", method: "project.list", params: { sessionNonce: nonce, projectHandle: workspaceHandle } });
    expect(await client.response("wrong")).toMatchObject({ error: { data: { code: "ROOT_HANDLE_INVALID" } } });
    client.send({ jsonrpc: "2.0", id: "plan", method: "plan.apply", params: { sessionNonce: nonce, path: "/tmp/not-authority", command: "sh", fakeSecret: "FAKE_SECRET" } });
    expect(await client.response("plan")).toMatchObject({ error: { data: { code: "INVALID_PARAMS" } } });

    expect(await client.close(nonce)).toBe(0);
    expect(snapshot(root)).toEqual(before);
    const protocolOutput = JSON.stringify(client.messages);
    expect(protocolOutput).not.toContain(projectRoot);
    expect(protocolOutput).not.toContain("FAKE_SECRET");
    expect(client.stderr).toBe("");
  });

  it("closes after three consecutive nonce failures without logging the nonce or raw path", { timeout: 15_000 }, async () => {
    const client = new Client(); const nonce = await client.initialize(); const fake = `${nonce}-FAKE_SECRET-/tmp/private-stack`;
    for (let index = 0; index < 3; index += 1) {
      client.send({ jsonrpc: "2.0", id: `bad-${index}`, method: "project.open", params: { sessionNonce: fake, path: "/tmp/private-stack" } });
      expect(await client.response(`bad-${index}`)).toMatchObject({ error: { data: { code: "SESSION_NONCE_INVALID" } } });
    }
    client.child.stdin.end();
    const exit = await new Promise<number | null>((resolve) => client.child.once("close", resolve));
    expect(exit).not.toBe(0);
    expect(client.stderr).not.toContain(nonce);
    expect(client.stderr).not.toContain("FAKE_SECRET");
    expect(client.stderr).not.toContain("/tmp/");
    expect(client.stderr).not.toContain("stack");
  });

  it("accepts split UTF-8 and multiple protocol frames in one OS-pipe chunk", { timeout: 15_000 }, async () => {
    const client = new Client();
    const init = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: "split", method: "initialize", params: { protocol: "tfsb.studio", minVersion: "1.0", maxVersion: "1.0", client: { name: "stellar-🌟", version: "1" }, capabilities: { progress: false, cancellation: true } } })}\n`);
    const star = init.indexOf(Buffer.from("🌟"));
    client.write(init.subarray(0, star + 2)); client.write(init.subarray(star + 2));
    const nonce = (await client.response("split")).result.sessionNonce as string;
    client.write(Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: { sessionNonce: nonce } })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: "shutdown", method: "shutdown", params: { sessionNonce: nonce } })}\n`,
    ));
    expect(await client.response("shutdown")).toMatchObject({ result: null });
    client.send({ jsonrpc: "2.0", method: "exit", params: {} }); client.child.stdin.end();
    expect(await new Promise<number | null>((resolve) => client.child.once("close", resolve))).toBe(0);
    expect(client.stderr).toBe("");
  });

  it("returns one sanitized protocol error and closes on malformed framing", { timeout: 15_000 }, async () => {
    const client = new Client(); client.write(Buffer.from("{}\r\n")); client.child.stdin.end();
    expect(await new Promise<number | null>((resolve) => client.child.once("close", resolve))).not.toBe(0);
    expect(client.messages).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "The JSON-RPC request is invalid.", data: { code: "INVALID_REQUEST", message: "The JSON-RPC request is invalid.", retryable: false } } }]);
    expect(client.stderr).not.toContain("\u001b");
  });

  it("qualifies 64/65 service pages and rejects CLI, replayed, and stale cursors", { timeout: 30_000 }, async () => {
    const root = temp(); const projectRoot = join(root, "projects/alpha");
    const ids = Array.from({ length: 65 }, (_, index) => `asset-${String(index).padStart(3, "0")}`); project(projectRoot, ids);
    const workspaceFile = join(root, ".tfsb-workspace.toml");
    const workspaceText = 'schema_version = 1\nid = "workspace"\nname = "Workspace"\n\n[[project]]\nid = "alpha"\npath = "projects/alpha"\ncollections = ["icons"]\n';
    writeFileSync(workspaceFile, workspaceText);
    const cliCursor = (await listWorkspace({ workspaceFile, pageSize: 64 })).page.nextCursor;
    expect(cliCursor).not.toBeNull();

    const firstClient = new Client(); const nonce = await firstClient.initialize();
    firstClient.send({ jsonrpc: "2.0", id: "po", method: "project.open", params: { sessionNonce: nonce, path: projectRoot } });
    const projectHandle = (await firstClient.response("po")).result.projectHandle as string;
    firstClient.send({ jsonrpc: "2.0", id: "wo", method: "workspace.open", params: { sessionNonce: nonce, path: workspaceFile } });
    const workspaceHandle = (await firstClient.response("wo")).result.workspaceHandle as string;

    firstClient.send({ jsonrpc: "2.0", id: "p1", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "project", projectHandle }, pageSize: 64 } });
    const projectFirst = await firstClient.response("p1"); expect(projectFirst.result.page).toMatchObject({ count: 64 });
    firstClient.send({ jsonrpc: "2.0", id: "p2", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "project", projectHandle }, pageSize: 64, cursor: projectFirst.result.page.nextCursor } });
    expect(await firstClient.response("p2")).toMatchObject({ result: { page: { count: 1, nextCursor: null } } });

    firstClient.send({ jsonrpc: "2.0", id: "w1", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 64 } });
    const workspaceFirst = await firstClient.response("w1"); expect(workspaceFirst.result.page).toMatchObject({ count: 64 });
    firstClient.send({ jsonrpc: "2.0", id: "w2", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 64, cursor: workspaceFirst.result.page.nextCursor } });
    expect(await firstClient.response("w2")).toMatchObject({ result: { page: { count: 1, nextCursor: null } } });
    firstClient.send({ jsonrpc: "2.0", id: "cli", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 64, cursor: cliCursor } });
    expect(await firstClient.response("cli")).toMatchObject({ error: { data: { code: "CURSOR_INVALID" } } });

    const replayCursor = projectFirst.result.page.nextCursor as string;
    const secondClient = new Client(); const secondNonce = await secondClient.initialize();
    secondClient.send({ jsonrpc: "2.0", id: "po2", method: "project.open", params: { sessionNonce: secondNonce, path: projectRoot } });
    const secondProjectHandle = (await secondClient.response("po2")).result.projectHandle as string;
    secondClient.send({ jsonrpc: "2.0", id: "replay", method: "asset.list", params: { sessionNonce: secondNonce, scope: { kind: "project", projectHandle: secondProjectHandle }, pageSize: 64, cursor: replayCursor } });
    expect(await secondClient.response("replay")).toMatchObject({ error: { data: { code: "CURSOR_INVALID" } } });

    firstClient.send({ jsonrpc: "2.0", id: "fresh-project", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "project", projectHandle }, pageSize: 64 } });
    const staleProjectCursor = (await firstClient.response("fresh-project")).result.page.nextCursor;
    firstClient.send({ jsonrpc: "2.0", id: "fresh-child-workspace", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 64 } });
    const staleChildCursor = (await firstClient.response("fresh-child-workspace")).result.page.nextCursor;
    const lastAsset = join(projectRoot, ".tfsb/assets/asset-064.toml"); writeFileSync(lastAsset, readFileSync(lastAsset, "utf8").replace('title = "Synthetic"', 'title = "Changed"'));
    firstClient.send({ jsonrpc: "2.0", id: "stale-project", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "project", projectHandle }, pageSize: 64, cursor: staleProjectCursor } });
    expect(await firstClient.response("stale-project")).toMatchObject({ error: { data: { code: "CURSOR_STALE" } } });
    firstClient.send({ jsonrpc: "2.0", id: "stale-child-workspace", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 64, cursor: staleChildCursor } });
    expect(await firstClient.response("stale-child-workspace")).toMatchObject({ error: { data: { code: "CURSOR_STALE" } } });

    firstClient.send({ jsonrpc: "2.0", id: "fresh-workspace", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 64 } });
    const staleManifestCursor = (await firstClient.response("fresh-workspace")).result.page.nextCursor;
    writeFileSync(workspaceFile, workspaceText.replace('name = "Workspace"', 'name = "Changed"'));
    firstClient.send({ jsonrpc: "2.0", id: "stale-workspace", method: "asset.list", params: { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 64, cursor: staleManifestCursor } });
    expect(await firstClient.response("stale-workspace")).toMatchObject({ error: { data: { code: "CURSOR_STALE" } } });

    expect(await secondClient.close(secondNonce)).toBe(0); expect(await firstClient.close(nonce)).toBe(0);
  });

  it("orders bounded progress and cancels active source analysis at a file boundary", { timeout: 30_000 }, async () => {
    const root = temp(); const source = join(root, "source"); mkdirSync(source);
    const svg = readRepoFile("test/fixtures/tftn-icon-candidate-v1/favicon.svg");
    for (let index = 0; index < 200; index += 1) writeFileSync(join(source, `asset-${String(index).padStart(3, "0")}.svg`), svg);
    const client = new Client(); const nonce = await client.initialize(true);
    client.send({ jsonrpc: "2.0", id: "open-source", method: "source.open", params: { sessionNonce: nonce, path: source } });
    const sourceHandle = (await client.response("open-source")).result.sourceHandle as string;
    client.messages.splice(0);
    client.send({ jsonrpc: "2.0", id: "analyze-progress", method: "source.analyze", params: { sessionNonce: nonce, sourceHandle, includeDetails: true, pageSize: 1 } });
    expect(await client.response("analyze-progress")).toMatchObject({ result: { details: { count: 1, nextCursor: expect.any(String) } } });
    const progress = client.messages.filter((value) => typeof value === "object" && value !== null && (value as any).method === "$/progress" && (value as any).params.requestId === "analyze-progress") as any[];
    expect(progress[0]?.params.stage).toBe("started");
    expect(progress.at(-1)?.params.stage).toBe("complete");
    expect(progress.filter((value) => value.params.stage === "scanning").map((value) => value.params.completed)).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));

    client.send({ jsonrpc: "2.0", id: "cancel-me", method: "source.analyze", params: { sessionNonce: nonce, sourceHandle, includeDetails: false, pageSize: 64 } });
    client.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { sessionNonce: nonce, id: "cancel-me" } });
    expect(await client.response("cancel-me")).toMatchObject({ error: { data: { code: "REQUEST_CANCELLED" } } });
    expect(await client.close(nonce)).toBe(0);
  });
});
