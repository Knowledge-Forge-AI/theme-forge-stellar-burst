import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { parseDesignEvidencePacket, serializeDesignEvidencePacket, validateDesignEvidenceReviewLinks, type DesignBriefPacketV1, type DesignCandidatePacketV1, type DesignReviewPacketV1 } from "../src/design-evidence/index.js";
import { createDeriveProject } from "./service-protocol/brand-test-helper.js";

const examples = join(process.cwd(), "protocol/tfsb-design-evidence-v1/examples");
const packedBinary = join(process.cwd(), "apps/studio/src-tauri/binaries/tfsb-studio-service-aarch64-apple-darwin");
const packedEntrypoint = join(process.cwd(), "apps/studio/src-tauri/sidecar-payload/dist/service-protocol/server-cli.js");
const unpackedEntrypoint = join(process.cwd(), "dist/service-protocol/server-cli.js");
const requestedHostMode = process.env.TFSB_DESIGN_EVIDENCE_HOST_MODE ?? "unpacked-development";
if (requestedHostMode !== "unpacked-development" && requestedHostMode !== "packed-required") {
  throw new Error(`Unsupported TFSB_DESIGN_EVIDENCE_HOST_MODE: ${requestedHostMode}`);
}
const hostMode: "unpacked-development" | "packed-required" = requestedHostMode;
const packet = async <T>(name: string): Promise<T> => parseDesignEvidencePacket(await readFile(join(examples, name))) as T;
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const scratch: string[] = [];

class ServiceOwner {
  readonly child: ChildProcessWithoutNullStreams;
  readonly hostKind: "unpacked-development" | "packed-binary";
  readonly messages: unknown[] = [];
  readonly #waiters: (() => void)[] = [];

  constructor() {
    if (hostMode === "packed-required" && (!existsSync(packedBinary) || !existsSync(packedEntrypoint))) {
      throw new Error(`Packed sidecar binary or entrypoint missing: binary=${existsSync(packedBinary)}, entrypoint=${existsSync(packedEntrypoint)}`);
    }
    this.hostKind = hostMode === "packed-required" ? "packed-binary" : "unpacked-development";
    this.child = hostMode === "packed-required"
      ? spawn(packedBinary, [packedEntrypoint], {
          cwd: join(process.cwd(), "apps/studio/src-tauri/sidecar-payload"),
          env: { LANG: "C", LC_ALL: "C", TZ: "UTC", TMPDIR: tmpdir() },
          stdio: "pipe",
        })
      : spawn(process.execPath, [unpackedEntrypoint], { stdio: "pipe" });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as unknown;
      if (typeof message === "object" && message !== null && "method" in message) return;
      this.messages.push(message); this.#waiters.splice(0).forEach((done) => done());
    });
  }

  async call(id: string, method: string, params: object): Promise<Record<string, unknown>> {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex((value) => typeof value === "object" && value !== null && "id" in value && (value as { id: unknown }).id === id);
      if (index >= 0) return this.messages.splice(index, 1)[0] as Record<string, unknown>;
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${id}`)), Math.max(1, deadline - Date.now())); this.#waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
    throw new Error(`Timed out waiting for ${id}`);
  }

  async initialize(): Promise<string> {
    const response = await this.call("initialize", "initialize", { protocol: "tfsb.studio", minVersion: "1.2", maxVersion: "1.2", client: { name: "design-evidence-roundtrip", version: "1" }, capabilities: { progress: true, cancellation: true } });
    const nonce = (response.result as { sessionNonce: string }).sessionNonce;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: { sessionNonce: nonce } })}\n`);
    return nonce;
  }

  async close(nonce: string): Promise<number | null> {
    expect(await this.call("shutdown", "shutdown", { sessionNonce: nonce })).toMatchObject({ result: null });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "exit", params: {} })}\n`); this.child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve) => this.child.once("close", resolve));
    expect(exitCode).toBe(0);
    return exitCode;
  }
}

afterEach(async () => { for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("root API/CLI and selected sidecar lifecycle", () => {
  it("qualifies packet serialization, CLI validation, and selected sidecar lifecycle", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "tfsb47l-roundtrip-")); scratch.push(directory);
    const project = await createDeriveProject(); scratch.push(project);
    const brief = await packet<DesignBriefPacketV1>("brief.json");
    const candidates = [await packet<DesignCandidatePacketV1>("candidate-a.json"), await packet<DesignCandidatePacketV1>("candidate-b.json")];
    const review = await packet<DesignReviewPacketV1>("review.json");
    const files = [["roundtrip.tfsb-brief.json", brief], ["candidate-a.tfsb-candidate.json", candidates[0]!], ["candidate-b.tfsb-candidate.json", candidates[1]!], ["roundtrip.tfsb-review.json", review]] as const;
    const machineOutput: string[] = []; const cliObservations: Array<{ packet: string; operation: "validate" | "inspect"; exitCode: number; outputByteCount: number; outputSha256: string }> = [];
    const io = { stdout: (text: string) => machineOutput.push(text), stderr: (text: string) => machineOutput.push(text) };
    const serializedPackets: Array<{ name: string; digest: string; byteCount: number; sha256: string }> = [];
    for (const [name, value] of files) {
      const serialized = serializeDesignEvidencePacket(value); const path = join(directory, name); await writeFile(path, serialized);
      const digest = value.schema === "tfsb.design-brief" ? value.briefDigest : value.schema === "tfsb.design-candidate" ? value.candidateDigest : value.reviewDigest;
      serializedPackets.push({ name, digest, byteCount: Buffer.byteLength(serialized), sha256: sha256(serialized) });
      const validateStart = machineOutput.length; const validateExitCode = await runCli(["evidence", "validate", path, "--json"], process.cwd(), io); const validateOutput = machineOutput.slice(validateStart).join("");
      expect(validateExitCode).toBe(0); cliObservations.push({ packet: name, operation: "validate", exitCode: validateExitCode, outputByteCount: Buffer.byteLength(validateOutput), outputSha256: sha256(validateOutput) });
      const inspectStart = machineOutput.length; const inspectExitCode = await runCli(["evidence", "inspect", path, "--json"], process.cwd(), io); const inspectOutput = machineOutput.slice(inspectStart).join("");
      expect(inspectExitCode).toBe(0); cliObservations.push({ packet: name, operation: "inspect", exitCode: inspectExitCode, outputByteCount: Buffer.byteLength(inspectOutput), outputSha256: sha256(inspectOutput) });
    }
    validateDesignEvidenceReviewLinks(review, candidates);
    expect(review.annotations.map(({ scope }) => scope.kind)).toEqual(["artifact", "region"]);
    expect(review.overallDisposition).toEqual({ kind: "needs-revision", candidateDigest: candidates[1]!.candidateDigest });

    const host = new ServiceOwner(); const nonce = await host.initialize();
    const opened = await host.call("open", "project.open", { sessionNonce: nonce, path: await realpath(project) });
    if (!("result" in opened)) throw new Error(`Project open failed with ${JSON.stringify((opened.error as { data?: { code?: string } } | undefined)?.data?.code ?? "unknown")}`);
    const projectHandle = (opened.result as { projectHandle: string }).projectHandle;
    const planned = await host.call("create-plan", "brand.derive.plan", { sessionNonce: nonce, projectHandle, selection: { kind: "all" } });
    const plan = planned.result as { planToken: string; planDigest: string; method: string };
    expect(plan.method).toBe("brand.derive.plan");
    expect(await host.call("discard-plan", "plan.discard", { sessionNonce: nonce, planToken: plan.planToken })).toMatchObject({ result: { discarded: true } });
    const hostExitCode = await host.close(nonce);

    const restarted = new ServiceOwner(); const restartedNonce = await restarted.initialize();
    expect(await restarted.call("old-plan", "plan.discard", { sessionNonce: restartedNonce, planToken: plan.planToken })).toMatchObject({ error: { data: { code: "PLAN_TOKEN_INVALID" } } });
    const restartedExitCode = await restarted.close(restartedNonce);

    const packedIdentity = host.hostKind === "packed-binary"
      ? {
          binarySha256: createHash("sha256").update(await readFile(packedBinary)).digest("hex"),
          manifestDigest: (JSON.parse(await readFile(join(process.cwd(), "apps/studio/src-tauri/sidecar-payload/manifest.json"), "utf8")) as { manifestDigest: string }).manifestDigest,
        }
      : null;

    const record = {
      schema: "tfsb.design-evidence-roundtrip-qualification", schemaVersion: 1,
      packetDigests: { brief: brief.briefDigest, candidates: candidates.map(({ candidateDigest }) => candidateDigest), review: review.reviewDigest, proposalCandidate: candidates[0]!.candidateDigest },
      owners: {
        publicApi: { packetCount: serializedPackets.length, packets: serializedPackets },
        cli: { observations: cliObservations },
        sidecar: {
          hostKind: host.hostKind,
          packedIdentity,
          protocolVersion: "1.2",
          exitCode: hostExitCode,
          reaped: true,
        },
        restartedSidecar: {
          hostKind: restarted.hostKind,
          priorTokenInvalid: true,
          exitCode: restartedExitCode,
          reaped: true,
        },
        directSidecarPlanLifecycle: {
          planDigest: plan.planDigest,
          method: plan.method,
          discarded: true,
        },
      },
      privacy: "sanitized-no-handles-paths-tokens-or-nonces",
    } as const;
    const recordPath = join(directory, "roundtrip-evidence.json"); await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(record);
    expect(`${machineOutput.join("")}\n${JSON.stringify(record)}`).not.toMatch(/bytesBase64|projectHandle|sourceHandle|planToken|requestId|sessionNonce|provider|model/u);
  });
});
