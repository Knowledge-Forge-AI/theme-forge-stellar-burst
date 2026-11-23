import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { computeSha256 } from "../src/digests.js";
import {
  NATIVE_AGENT_LEDGER_FILENAME,
  NATIVE_AGENT_RESULT_FILENAME,
  NATIVE_AGENT_SOURCE_FILENAME,
  type NativeAgentRunner,
  runNativeCodexIllustration,
} from "../src/illustration/native-agent.js";

const SYNTHETIC_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 115, 121, 110, 116, 104, 101, 116, 105, 99]);
const REFERENCE_WEBP = Buffer.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 114, 101, 105]);
let scratchRoot = "";
let sequence = 0;
const jobs: string[] = [];

type Behavior = "success" | "invalid-result" | "bom-result" | "duplicate-result" | "traversal-result" | "deep-result" | "source-symlink" | "source-hardlink" | "source-fifo" | "source-too-large" | "non-png" | "result-mode" | "result-hardlink" | "result-only" | "ledger-symlink" | "ledger-hardlink" | "ledger-replacement" | "ledger-alias" | "timeout" | "large-output" | "nonzero";

interface RunnerCapture {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[]; readonly cwd: string }>;
  readonly runner: NativeAgentRunner;
}

function nextJob(label: string): string {
  sequence += 1;
  const path = join(scratchRoot, `${label}-${process.pid}-${sequence}`);
  jobs.push(path);
  return path;
}

function request(jobDirectory: string, operation: "generate" | "edit" = "generate", referenceImagePaths: readonly string[] = [], timeoutMs = 1_000) {
  return { prompt: "private pilot prompt that must not reach the ledger", operation, referenceImagePaths, jobDirectory, timeoutMs } as const;
}

function localNodeRunner(behavior: Behavior, provider = "openai", model = "gpt-image-1"): RunnerCapture {
  const calls: Array<{ readonly command: string; readonly args: readonly string[]; readonly cwd: string }> = [];
  const runner: NativeAgentRunner = (spec) => {
    calls.push({ command: spec.command, args: spec.args, cwd: spec.cwd });
    const script = `
      import { chmod, link, rename, symlink, unlink, writeFile } from "node:fs/promises";
      const outputPath = process.argv[1];
      const sourcePath = process.argv[2];
      const mode = process.argv[3];
      const provider = process.argv[4];
      const model = process.argv[5];
      const final = (extra = {}) => JSON.stringify({ sourceFilename: "source.png", provider, model, ...extra }) + "\\n";
      let prompt = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { prompt += chunk; });
      process.stdin.on("end", async () => {
        if (mode === "large-output") {
          process.stdout.write("x".repeat(70 * 1024));
          await writeFile(sourcePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 115, 121, 110, 116, 104, 101, 116, 105, 99]));
          await writeFile(outputPath, final());
          return;
        }
        if (mode === "source-too-large") {
          await writeFile(sourcePath, Buffer.alloc(32 * 1024 * 1024 + 1));
          await writeFile(outputPath, final());
          return;
        }
        if (mode === "timeout") {
          setTimeout(async () => {
            await writeFile(sourcePath, Buffer.from("late-source"));
            await writeFile(outputPath, final());
          }, 250);
          return;
        }
        if (mode === "invalid-result") {
          await writeFile(outputPath, "not json\\n");
          return;
        }
        if (mode === "bom-result") {
          await writeFile(outputPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(final())]));
          return;
        }
        if (mode === "duplicate-result") {
          await writeFile(outputPath, '{"sourceFilename":"source.png","sourceFilename":"source.png","provider":null,"model":null}\\n');
          return;
        }
        if (mode === "traversal-result") {
          await writeFile(outputPath, JSON.stringify({ sourceFilename: "../source.png", provider: null, model: null }) + "\\n");
          return;
        }
        if (mode === "deep-result") {
          let nested = "null";
          for (let index = 0; index < 10; index += 1) nested = "{\\"x\\":" + nested + "}";
          await writeFile(outputPath, "{\\"sourceFilename\\":\\"source.png\\",\\"provider\\":null,\\"model\\":" + nested + "}\\n");
          return;
        }
        if (mode === "source-symlink") {
          const targetPath = sourcePath + ".target";
          await writeFile(targetPath, Buffer.from("symlink-source"));
          await symlink(targetPath, sourcePath);
          await writeFile(outputPath, final());
          return;
        }
        if (mode === "source-fifo" || mode === "result-only") {
          await writeFile(outputPath, final());
          return;
        }
        if (mode === "non-png") {
          await writeFile(sourcePath, Buffer.from("not-png"));
          await writeFile(outputPath, final());
          return;
        }
        if (mode === "result-mode") {
          await writeFile(sourcePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 115, 121, 110, 116, 104, 101, 116, 105, 99]));
          await writeFile(outputPath, final());
          await chmod(outputPath, 0o644);
          return;
        }
        if (mode === "result-hardlink") {
          const targetPath = outputPath + ".target";
          await writeFile(targetPath, final());
          await chmod(targetPath, 0o600);
          await unlink(outputPath);
          await link(targetPath, outputPath);
          await writeFile(sourcePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 115, 121, 110, 116, 104, 101, 116, 105, 99]));
          return;
        }
        if (mode === "source-hardlink") {
          const targetPath = sourcePath + ".target";
          await writeFile(targetPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 115, 121, 110, 116, 104, 101, 116, 105, 99]));
          await chmod(targetPath, 0o644);
          await link(targetPath, sourcePath);
          await writeFile(outputPath, final());
          return;
        }
        if (mode === "ledger-symlink") {
          const ledgerPath = sourcePath.replace(/source\\.png$/u, "ledger.json");
          await unlink(ledgerPath);
          await symlink(sourcePath, ledgerPath);
        }
        if (mode === "ledger-hardlink") {
          const ledgerPath = sourcePath.replace(/source\\.png$/u, "ledger.json");
          const targetPath = ledgerPath + ".target";
          await writeFile(targetPath, Buffer.from("ledger-target-must-remain-unchanged"), { mode: 0o644 });
          await chmod(targetPath, 0o644);
          await unlink(ledgerPath);
          await link(targetPath, ledgerPath);
        }
        if (mode === "ledger-replacement") {
          const ledgerPath = sourcePath.replace(/source\\.png$/u, "ledger.json");
          const replacementPath = ledgerPath + ".replacement";
          await writeFile(replacementPath, Buffer.from("ledger-replacement-must-remain-unchanged"), { mode: 0o600 });
          await chmod(replacementPath, 0o600);
          await rename(replacementPath, ledgerPath);
        }
        if (mode === "ledger-alias") {
          const ledgerPath = sourcePath.replace(/source\\.png$/u, "ledger.json");
          await link(ledgerPath, ledgerPath + ".alias");
        }
        await writeFile(sourcePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 115, 121, 110, 116, 104, 101, 116, 105, 99]));
        await writeFile(outputPath, final());
        if (mode === "nonzero") process.exitCode = 7;
      });
    `;
    return spawn(process.execPath, ["--input-type=module", "-e", script, spec.outputPath, join(spec.cwd, "source.png"), behavior, provider, model], {
      cwd: spec.cwd,
      env: process.env,
      shell: false,
      detached: spec.detached,
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
  return { calls, runner };
}

async function makeFifo(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("mkfifo", [path], { shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("mkfifo failed"));
    });
  });
}

async function fifoAvailable(): Promise<boolean> {
  if (process.platform === "win32") return false;
  const probe = join(scratchRoot, "fifo-probe");
  try {
    await makeFifo(probe);
    await rm(probe, { force: true });
    return true;
  } catch {
    await rm(probe, { force: true });
    return false;
  }
}

function fifoNodeRunner(): RunnerCapture {
  const base = localNodeRunner("result-only");
  const runner: NativeAgentRunner = async (spec) => {
    await makeFifo(join(spec.cwd, NATIVE_AGENT_SOURCE_FILENAME));
    return base.runner(spec);
  };
  return { calls: base.calls, runner };
}

async function ledger(jobDirectory: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(jobDirectory, NATIVE_AGENT_LEDGER_FILENAME), "utf8")) as Record<string, unknown>;
}

beforeAll(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), "tfsb-native-agent-"));
  await chmod(scratchRoot, 0o700);
});

afterEach(async () => {
  for (const job of jobs.splice(0)) await rm(job, { recursive: true, force: true });
});

afterAll(async () => {
  if (scratchRoot !== "") await rm(scratchRoot, { recursive: true, force: true });
});

describe("TFSB native Codex illustration adapter", () => {
  it("dispatches one bounded generate request through the fixed argv contract and binds source bytes", async () => {
    const job = nextJob("generate");
    const fake = localNodeRunner("success");
    const result = await runNativeCodexIllustration(request(job), { runner: fake.runner });

    expect(result.state).toBe("completed");
    if (result.state !== "completed") throw new Error("expected completed result");
    expect(result.operation).toBe("generate");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-image-1");
    expect(result.source.filename).toBe(NATIVE_AGENT_SOURCE_FILENAME);
    expect(result.source.bytes).toBe(SYNTHETIC_PNG.byteLength);
    expect(result.source.sha256).toBe(computeSha256(SYNTHETIC_PNG));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.command).toBe("codex");
    expect(fake.calls[0]?.args.slice(0, 7)).toEqual(["exec", "--ephemeral", "--sandbox", "workspace-write", "--skip-git-repo-check", "--cd", job]);
    expect(fake.calls[0]?.args).toContain("--output-last-message");
    expect(fake.calls[0]?.args).not.toContain("private pilot prompt that must not reach the ledger");

    const jobStat = await lstat(job);
    const ledgerStat = await lstat(join(job, NATIVE_AGENT_LEDGER_FILENAME));
    const resultStat = await lstat(join(job, NATIVE_AGENT_RESULT_FILENAME));
    expect(jobStat.mode & 0o777).toBe(0o700);
    expect(ledgerStat.mode & 0o777).toBe(0o600);
    expect(resultStat.mode & 0o777).toBe(0o600);
    const record = await ledger(job);
    expect(record).toMatchObject({ schema: "tfsb.illustration.native-agent-v1", state: "completed", operation: "generate", sourceFilename: "source.png", provider: "openai", model: "gpt-image-1", sourceBytes: SYNTHETIC_PNG.byteLength });
    expect(JSON.stringify(record)).not.toContain("private pilot prompt");
  }, 10_000);

  it("copies explicit generation and edit references into private job-owned files without retaining the caller path in the ledger", async () => {
    const reference = join(scratchRoot, "reference-public-rei.png");
    jobs.push(reference);
    await writeFile(reference, REFERENCE_WEBP, { mode: 0o644 });
    const generationJob = nextJob("generate-with-reference");
    const fake = localNodeRunner("success", "openai", "gpt-image-1");
    const generated = await runNativeCodexIllustration(request(generationJob, "generate", [reference]), { runner: fake.runner });
    expect(generated.state).toBe("completed");

    const editJob = nextJob("edit");
    const result = await runNativeCodexIllustration(request(editJob, "edit", [reference]), { runner: fake.runner });

    expect(result.state).toBe("completed");
    const copied = await readFile(join(editJob, "references", "0.webp"));
    expect(copied).toEqual(REFERENCE_WEBP);
    const copiedStat = await lstat(join(editJob, "references", "0.webp"));
    expect(copiedStat.mode & 0o777).toBe(0o600);
    const editLedger = await ledger(editJob);
    expect(editLedger.referenceSha256s).toEqual([computeSha256(REFERENCE_WEBP)]);
    expect(JSON.stringify(editLedger)).not.toContain(reference);
  }, 10_000);

  it("keeps provider/model token acceptance aligned with the v1 recordability predicate", async () => {
    const acceptedJob = nextJob("recordable-token");
    const accepted = localNodeRunner("success", "api-gateway", "gpt-image-1");
    await expect(runNativeCodexIllustration(request(acceptedJob), { runner: accepted.runner })).resolves.toMatchObject({ state: "completed", provider: "api-gateway" });

    const rejectedJob = nextJob("private-token");
    const rejected = localNodeRunner("success", "api-key-leak", "gpt-image-1");
    await expect(runNativeCodexIllustration(request(rejectedJob), { runner: rejected.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "RESULT_INVALID" });
  }, 10_000);

  it("refuses repeated dispatch and unsafe reference paths before spawning a child", async () => {
    const existing = nextJob("existing");
    await mkdir(existing, { mode: 0o700 });
    const fake = localNodeRunner("success");
    await expect(runNativeCodexIllustration(request(existing), { runner: fake.runner })).rejects.toMatchObject({ code: "JOB_DIRECTORY_EXISTS" });
    expect(fake.calls).toHaveLength(0);

    const traversal = `${scratchRoot}/../escape-${process.pid}`;
    await expect(runNativeCodexIllustration(request(traversal), { runner: fake.runner })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const controlPath = `${scratchRoot}/bad\njob`;
    await expect(runNativeCodexIllustration(request(controlPath), { runner: fake.runner })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const multilineJob = nextJob("multiline-prompt");
    const multiline = { ...request(multilineJob), prompt: "line one\nline two\tline three\r\n" };
    const multilineFake = localNodeRunner("success");
    await expect(runNativeCodexIllustration(multiline, { runner: multilineFake.runner })).resolves.toMatchObject({ state: "completed" });

    const target = join(scratchRoot, "symlink-target.png");
    const link = join(scratchRoot, "symlink-reference.png");
    jobs.push(target, link);
    await writeFile(target, Buffer.from("target"));
    await symlink(target, link);
    await expect(runNativeCodexIllustration(request(nextJob("symlink"), "edit", [link]), { runner: fake.runner })).rejects.toMatchObject({ code: "REFERENCE_INVALID" });
    expect(fake.calls).toHaveLength(0);

    const unsupported = join(scratchRoot, "unsupported-reference.bin");
    jobs.push(unsupported);
    await writeFile(unsupported, Buffer.from("not-an-image"));
    await expect(runNativeCodexIllustration(request(nextJob("unsupported"), "edit", [unsupported]), { runner: fake.runner })).rejects.toMatchObject({ code: "REFERENCE_INVALID" });
    expect(fake.calls).toHaveLength(0);

    const accessorRequest = request(nextJob("accessor"));
    Object.defineProperty(accessorRequest, "prompt", { enumerable: true, get: () => { throw new Error("prompt getter executed"); } });
    await expect(runNativeCodexIllustration(accessorRequest, { runner: fake.runner })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const symbolRequest = { ...request(nextJob("symbol")), [Symbol("private")]: "unexpected" };
    await expect(runNativeCodexIllustration(symbolRequest, { runner: fake.runner })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fake.calls).toHaveLength(0);
  }, 10_000);

  it("records malformed child JSON as unknown after dispatch and rejects duplicate or traversing source names", async () => {
    const invalidJob = nextJob("invalid");
    const invalid = localNodeRunner("invalid-result");
    await expect(runNativeCodexIllustration(request(invalidJob), { runner: invalid.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "RESULT_INVALID" });
    expect(await ledger(invalidJob)).toMatchObject({ state: "unknown", failureCode: "RESULT_INVALID" });

    const bomJob = nextJob("bom");
    const bom = localNodeRunner("bom-result");
    await expect(runNativeCodexIllustration(request(bomJob), { runner: bom.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "RESULT_INVALID" });

    const duplicateJob = nextJob("duplicate");
    const duplicate = localNodeRunner("duplicate-result");
    await expect(runNativeCodexIllustration(request(duplicateJob), { runner: duplicate.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "RESULT_INVALID" });

    const traversalJob = nextJob("traversal-result");
    const traversal = localNodeRunner("traversal-result");
    await expect(runNativeCodexIllustration(request(traversalJob), { runner: traversal.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "RESULT_INVALID" });

    const deepJob = nextJob("deep-result");
    const deep = localNodeRunner("deep-result");
    await expect(runNativeCodexIllustration(request(deepJob), { runner: deep.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "RESULT_INVALID" });
  }, 10_000);

  it("classifies a runner spawn failure before any child request as failed", async () => {
    const job = nextJob("spawn-failure");
    const runner: NativeAgentRunner = () => { throw new Error("local spawn unavailable"); };
    const result = await runNativeCodexIllustration(request(job), { runner });
    expect(result).toMatchObject({ state: "failed", failureCode: "SPAWN_FAILED" });
    expect(result.process.spawned).toBe(false);
    expect((await ledger(job))).toMatchObject({ state: "failed", failureCode: "SPAWN_FAILED" });
  }, 10_000);

  it("does not bind a symlinked source and refuses ledger identity substitution", async () => {
    const sourceJob = nextJob("source-symlink");
    const source = localNodeRunner("source-symlink");
    await expect(runNativeCodexIllustration(request(sourceJob), { runner: source.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "SOURCE_INVALID" });
    expect(await ledger(sourceJob)).toMatchObject({ state: "unknown", failureCode: "SOURCE_INVALID" });

    const hardlinkJob = nextJob("source-hardlink");
    const hardlink = localNodeRunner("source-hardlink");
    await expect(runNativeCodexIllustration(request(hardlinkJob), { runner: hardlink.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "SOURCE_INVALID" });
    expect((await lstat(join(hardlinkJob, "source.png.target"))).mode & 0o777).toBe(0o644);

    if (await fifoAvailable()) {
      const fifoJob = nextJob("source-fifo");
      const fifo = fifoNodeRunner();
      await expect(runNativeCodexIllustration(request(fifoJob), { runner: fifo.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "SOURCE_INVALID" });
    }

    const nonPngJob = nextJob("non-png");
    const nonPng = localNodeRunner("non-png");
    await expect(runNativeCodexIllustration(request(nonPngJob), { runner: nonPng.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "SOURCE_INVALID" });

    const tooLargeJob = nextJob("source-too-large");
    const tooLarge = localNodeRunner("source-too-large");
    await expect(runNativeCodexIllustration(request(tooLargeJob), { runner: tooLarge.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "SOURCE_TOO_LARGE" });

    const modeJob = nextJob("result-mode");
    const mode = localNodeRunner("result-mode");
    await expect(runNativeCodexIllustration(request(modeJob), { runner: mode.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "RESULT_INVALID" });
    expect((await lstat(join(modeJob, NATIVE_AGENT_RESULT_FILENAME))).mode & 0o777).toBe(0o644);

    const resultHardlinkJob = nextJob("result-hardlink");
    const resultHardlink = localNodeRunner("result-hardlink");
    await expect(runNativeCodexIllustration(request(resultHardlinkJob), { runner: resultHardlink.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "RESULT_INVALID" });
    expect((await lstat(join(resultHardlinkJob, `${NATIVE_AGENT_RESULT_FILENAME}.target`))).mode & 0o777).toBe(0o600);

    const ledgerJob = nextJob("ledger-symlink");
    const substituted = localNodeRunner("ledger-symlink");
    await expect(runNativeCodexIllustration(request(ledgerJob), { runner: substituted.runner })).rejects.toMatchObject({ code: "LEDGER_WRITE_FAILED", state: "unknown", dispatched: true });

    const ledgerHardlinkJob = nextJob("ledger-hardlink");
    const hardlinkLedger = localNodeRunner("ledger-hardlink");
    await expect(runNativeCodexIllustration(request(ledgerHardlinkJob), { runner: hardlinkLedger.runner })).rejects.toMatchObject({ code: "LEDGER_WRITE_FAILED", state: "unknown", dispatched: true });
    const ledgerTarget = join(ledgerHardlinkJob, `${NATIVE_AGENT_LEDGER_FILENAME}.target`);
    expect(await readFile(ledgerTarget)).toEqual(Buffer.from("ledger-target-must-remain-unchanged"));
    expect((await lstat(ledgerTarget)).mode & 0o777).toBe(0o644);

    const replacementJob = nextJob("ledger-replacement");
    const replacement = localNodeRunner("ledger-replacement");
    await expect(runNativeCodexIllustration(request(replacementJob), { runner: replacement.runner })).rejects.toMatchObject({ code: "LEDGER_WRITE_FAILED", state: "unknown", dispatched: true });
    const replacementLedger = join(replacementJob, NATIVE_AGENT_LEDGER_FILENAME);
    expect(await readFile(replacementLedger)).toEqual(Buffer.from("ledger-replacement-must-remain-unchanged"));
    expect((await lstat(replacementLedger)).mode & 0o777).toBe(0o600);

    const aliasJob = nextJob("ledger-alias");
    const aliasRunnerBase = localNodeRunner("ledger-alias");
    let preDispatchLedger: Buffer | undefined;
    const aliasRunner: NativeAgentRunner = async (spec) => {
      preDispatchLedger = await readFile(join(spec.cwd, NATIVE_AGENT_LEDGER_FILENAME));
      return aliasRunnerBase.runner(spec);
    };
    await expect(runNativeCodexIllustration(request(aliasJob), { runner: aliasRunner })).rejects.toMatchObject({ code: "LEDGER_WRITE_FAILED", state: "unknown", dispatched: true });
    expect(preDispatchLedger).toBeDefined();
    const aliasLedger = join(aliasJob, NATIVE_AGENT_LEDGER_FILENAME);
    const aliasPath = `${aliasLedger}.alias`;
    expect(await readFile(aliasPath)).toEqual(preDispatchLedger);
    expect(await readFile(aliasLedger)).toEqual(preDispatchLedger);
    expect((await lstat(aliasLedger)).nlink).toBe(2);

    if (await fifoAvailable()) {
      const fifoJob = nextJob("ledger-fifo");
      const fifoBase = localNodeRunner("result-only");
      const fifoRunner: NativeAgentRunner = async (spec) => {
        const ledgerPath = join(spec.cwd, NATIVE_AGENT_LEDGER_FILENAME);
        await rm(ledgerPath, { force: true });
        await makeFifo(ledgerPath);
        return fifoBase.runner(spec);
      };
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const bounded = Promise.race([
        runNativeCodexIllustration(request(fifoJob), { runner: fifoRunner }),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("ledger FIFO did not settle")), 1_000); }),
      ]);
      try {
        await expect(bounded).rejects.toMatchObject({ code: "LEDGER_WRITE_FAILED", state: "unknown", dispatched: true });
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
      }
    }
  }, 10_000);

  it("treats timeout and nonzero exit as unknown while retaining bounded stream prefixes and draining overflow", async () => {
    const timeoutJob = nextJob("timeout");
    const timeout = localNodeRunner("timeout");
    const timed = await runNativeCodexIllustration(request(timeoutJob, "generate", [], 25), { runner: timeout.runner });
    expect(timed).toMatchObject({ state: "unknown", failureCode: "TIMEOUT" });
    expect(await ledger(timeoutJob)).toMatchObject({ state: "unknown", failureCode: "TIMEOUT" });

    const nonzeroJob = nextJob("nonzero");
    const nonzero = localNodeRunner("nonzero");
    await expect(runNativeCodexIllustration(request(nonzeroJob), { runner: nonzero.runner })).resolves.toMatchObject({ state: "unknown", failureCode: "PROCESS_EXIT" });

    const outputJob = nextJob("large-output");
    const output = localNodeRunner("large-output");
    const bounded = await runNativeCodexIllustration(request(outputJob), { runner: output.runner });
    expect(bounded).toMatchObject({ state: "completed" });
    expect(bounded.process.stdoutBytes).toBe(70 * 1024);
    expect(bounded.process.stdoutTruncated).toBe(true);
    expect(bounded.process.termination).toBe("none");
  }, 10_000);

  it("uses the test-only runner seam for abort without invoking the provider", async () => {
    const job = nextJob("abort");
    const controller = new AbortController();
    const fake = localNodeRunner("timeout");
    let resolveRunnerEntered!: () => void;
    const runnerEntered = new Promise<void>((resolve) => { resolveRunnerEntered = resolve; });
    const runner: NativeAgentRunner = (spec) => {
      resolveRunnerEntered();
      return fake.runner(spec);
    };
    const running = runNativeCodexIllustration(request(job, "generate", [], 1_000), { runner, signal: controller.signal });
    await runnerEntered;
    expect(fake.calls).toHaveLength(1);
    controller.abort();
    await expect(running).resolves.toMatchObject({ state: "unknown", failureCode: "ABORTED" });
    expect(await ledger(job)).toMatchObject({ state: "unknown", failureCode: "ABORTED" });
  }, 10_000);

  it("checks an abort immediately before the runner and does not create a child", async () => {
    const job = nextJob("abort-before-runner");
    let reads = 0;
    const signal = {
      get aborted(): boolean {
        reads += 1;
        return reads >= 3;
      },
      addEventListener(): void { /* test-only signal seam */ },
      removeEventListener(): void { /* test-only signal seam */ },
    } as unknown as AbortSignal;
    const fake = localNodeRunner("success");
    const result = await runNativeCodexIllustration(request(job), { runner: fake.runner, signal });
    expect(result).toMatchObject({ state: "failed", failureCode: "ABORTED_BEFORE_DISPATCH" });
    expect(fake.calls).toHaveLength(0);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(await ledger(job)).toMatchObject({ state: "failed", failureCode: "ABORTED_BEFORE_DISPATCH" });
  }, 10_000);
});
