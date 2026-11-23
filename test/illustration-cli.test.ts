import { mkdtemp, realpath, chmod, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runIllustrationCli } from "../src/illustration-cli.js";
import { createRasterIllustrationRecord, serializeRasterIllustration } from "../src/illustration/v1.js";
import { NativeIllustrationAgentError } from "../src/illustration/native-agent.js";

const owned: string[] = [];
async function fixture() { const dir = await mkdtemp(join(await realpath(tmpdir()), "tfsb-illustration-cli-")); await chmod(dir, 0o700); owned.push(dir); return dir; }
function io() { const output = { stdout: "", stderr: "" }; return { output, stdout: (t: string) => { output.stdout += t; }, stderr: (t: string) => { output.stderr += t; } }; }
afterEach(async () => { for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("illustration CLI", () => {
  it("inspects canonical metadata without treating it as decoded/generation evidence", async () => {
    const dir = await fixture();
    const digest = `sha256:${"a".repeat(64)}` as const;
    const record = createRasterIllustrationRecord({ illustrationId: "rei-ai-import", revision: 1, operation: "import",
      characters: [{ id: "rei-ai", revision: 1 }], style: { id: "historical", revision: 1 }, provider: null, model: null,
      source: { sha256: digest, mime: "image/png", byteLength: 200, dimensions: { width: 1, height: 1 }, alpha: "unknown" },
      references: [], lineage: { parentDigest: null }, exportRecipes: [] });
    await writeFile(join(dir, "record.json"), serializeRasterIllustration(record));
    const stream = io();
    expect(await runIllustrationCli(["inspect", "record.json", "--json"], dir, stream)).toBe(0);
    const result = JSON.parse(stream.output.stdout);
    expect(result.data.metadataOnly).toBe(true);
    expect(result.data.operation).toBe("import");
    expect(result.data.digest).toBe(record.digest);
  });

  it("rejects malformed requests and usage without dispatch or private-value echo", async () => {
    const dir = await fixture(); const stream = io(); let called = false;
    const dispatch = async () => { called = true; throw new Error("must not run"); };
    await writeFile(join(dir, "bad.json"), JSON.stringify({ prompt: "private-fixture", extra: "not-allowed" }));
    expect(await runIllustrationCli(["generate", "--request", "bad.json", "--job-directory", "new-job", "--json"], dir, stream, dispatch)).toBe(1);
    expect(await runIllustrationCli(["generate", "--request", "bad.json", "--job-directory", "new-job", "--timeout-ms", "NaN", "--json"], dir, stream, dispatch)).toBe(1);
    await writeFile(join(dir, "bom.json"), "\uFEFF" + JSON.stringify({ prompt: "private-fixture", referenceImagePaths: [] }));
    expect(await runIllustrationCli(["generate", "--request", "bom.json", "--job-directory", "new-job", "--json"], dir, stream, dispatch)).toBe(1);
    expect(called).toBe(false);
    expect(stream.output.stdout + stream.output.stderr).not.toContain("private-fixture");
  });

  it("routes explicit referenced generation through a private request and preserves unknown outcomes", async () => {
    const dir = await fixture(); const stream = io(); let observed: unknown;
    await writeFile(join(dir, "request.json"), JSON.stringify({ prompt: "private-fixture", referenceImagePaths: ["reference.png"] }));
    const dispatch = async (value: unknown) => { observed = value; return {
      state: "unknown", operation: "generate", source: null, provider: null, model: null,
      failureCode: "TIMEOUT", process: {} as never, jobDirectory: join(dir, "new-job"),
    } as const; };
    expect(await runIllustrationCli(["generate", "--request", "request.json", "--job-directory", "new-job", "--json"], dir, stream, dispatch)).toBe(3);
    expect(observed).toMatchObject({ prompt: "private-fixture", referenceImagePaths: [join(dir, "reference.png")], operation: "generate", timeoutMs: 300000 });
    expect(JSON.parse(stream.output.stdout).state).toBe("unknown");
    expect(stream.output.stdout + stream.output.stderr).not.toContain("private-fixture");
    expect(stream.output.stdout + stream.output.stderr).not.toContain(dir);
  });

  it("forwards CLI interruption to the local dispatcher and removes signal handlers", async () => {
    const dir = await fixture(); const stream = io();
    await writeFile(join(dir, "request.json"), JSON.stringify({ prompt: "private-fixture", referenceImagePaths: [] }));
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    let aborted = false;
    const dispatch = async (_value: unknown, options?: { signal?: AbortSignal }) => {
      process.emit("SIGINT");
      aborted = options?.signal?.aborted === true;
      return { state: "unknown", operation: "generate", source: null, provider: null, model: null,
        failureCode: "ABORTED", process: {} as never, jobDirectory: join(dir, "new-job") } as const;
    };
    expect(await runIllustrationCli(["generate", "--request", "request.json", "--job-directory", "new-job", "--json"], dir, stream, dispatch)).toBe(3);
    expect(aborted).toBe(true);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    expect(JSON.parse(stream.output.stdout).data.failureCode).toBe("ABORTED");
  });

  it("reports ledger errors from the observed dispatch boundary without inventing a sent request", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "request.json"), JSON.stringify({ prompt: "private-fixture", referenceImagePaths: [] }));
    for (const dispatched of [false, true]) {
      const stream = io();
      const dispatch = async () => { throw new NativeIllustrationAgentError("LEDGER_WRITE_FAILED", "Private ledger failure.", "started", dispatched); };
      expect(await runIllustrationCli(["generate", "--request", "request.json", "--job-directory", "new-job", "--json"], dir, stream, dispatch)).toBe(3);
      expect(JSON.parse(stream.output.stdout).state).toBe(dispatched ? "unknown" : "failed");
    }
  });
});
