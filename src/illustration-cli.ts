import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { readRegularFileSnapshot } from "./filesystem.js";
import { parseDuplicateFreeJson } from "./brand/consumer-lock.js";
import { parseRasterIllustration } from "./illustration/v1.js";
import { NativeIllustrationAgentError, runNativeCodexIllustration, type NativeAgentResult } from "./illustration/native-agent.js";

interface IllustrationIo { stdout(text: string): void; stderr(text: string): void }
type Dispatcher = typeof runNativeCodexIllustration;

const USAGE = `Usage:
  tfsb illustration validate <record.json> [--json]
  tfsb illustration inspect <record.json> [--json]
  tfsb illustration record --request <metadata.json> --source <saved.png|webp> --mime <image/png|image/webp> --output <new-record.json> [--json]
  tfsb illustration capability [--json]
  tfsb illustration export --recipe <recipe.json> --source <saved.png|webp> --output <new-file> [--json]
  tfsb illustration carrier-create --request <private.json> --directory <new-directory> [--json]
  tfsb illustration carrier-inspect --directory <carrier> [--json]
  tfsb illustration consumer-init --root <consumer> --id <profile-id> --package <package-id> --illustration <illustration-id> --mapping <derivative-id=public/file.webp> [--json]
  tfsb illustration consumer-plan --root <consumer> --carrier <carrier> [--operation install|sync] [--json]
  tfsb illustration install|sync --root <consumer> --carrier <carrier> [--json]
  tfsb illustration generate --request <private.json> --job-directory <new-directory> [--timeout-ms <1..300000>] [--json]
  tfsb illustration edit --request <private.json> --job-directory <new-directory> [--timeout-ms <1..300000>] [--json]

Authoring is explicit and never retried automatically. Private request JSON has
only prompt and referenceImagePaths. Generate can use identity/style references;
edit requires a target reference. Unknown outcomes require reconciliation.
Validation checks metadata, not image decoding or artistic acceptance.`;

function reply(io: IllustrationIo, command: string, state: string, code: number, data: unknown, json: boolean): number {
  if (json) io.stdout(`${JSON.stringify({ schema: "tfsb.illustration-result-v1", command, state, exitCode: code, data }, null, 2)}\n`);
  else if (code === 0) io.stdout(`Illustration ${command}: ${state}.\n`);
  else {
    const failure = data && typeof data === "object" && "failureCode" in data
      && typeof data.failureCode === "string" && /^[A-Z_]{1,64}$/.test(data.failureCode) ? ` (${data.failureCode})` : "";
    io.stderr(`Illustration operation: ${state}${failure}; no automatic retry.\n`);
  }
  return code;
}

/** Narrow illustration CLI; dispatcher injection is an internal unit-test seam. */
export async function runIllustrationCli(argv: readonly string[], cwd: string, io: IllustrationIo, dispatch: Dispatcher = runNativeCodexIllustration): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { io.stdout(`${USAGE}\n`); return 0; }
  const json = argv.includes("--json");
  const [command, ...rest] = argv;
  if (command === "record") {
    const { runIllustrationRecordCli } = await import("./illustration/record-cli.js");
    return runIllustrationRecordCli(argv, cwd, io);
  }
  if (command && ["carrier-create", "carrier-inspect", "consumer-init", "consumer-plan", "install", "sync"].includes(command)) {
    const { runIllustrationConsumerCli } = await import("./illustration/consumer-cli.js");
    return runIllustrationConsumerCli(argv, cwd, io);
  }
  if (command === "capability" || command === "export") {
    const { runIllustrationDerivativeCli } = await import("./illustration/derivative-cli.js");
    return runIllustrationDerivativeCli(argv, cwd, io);
  }
  if (!command || !["validate", "inspect", "generate", "edit"].includes(command)) return reply(io, "request", "invalid-arguments", 1, null, json);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...rest], strict: true, allowPositionals: true, options: {
      json: { type: "boolean" }, request: { type: "string" }, "job-directory": { type: "string" }, "timeout-ms": { type: "string" },
    } });
  } catch { return reply(io, command, "invalid-arguments", 1, null, json); }
  if (command === "validate" || command === "inspect") {
    if (parsed.positionals.length !== 1 || Object.keys(parsed.values).some(k => k !== "json")) return reply(io, command, "invalid-arguments", 1, null, json);
    try {
      const file = await readRegularFileSnapshot(resolve(cwd, parsed.positionals[0]!), { operation: "validate", domain: "cli" }, "ILLUSTRATION_INPUT_INVALID", "Illustration input must be a bounded regular file.", 1_048_576);
      const record = parseRasterIllustration(file.bytes);
      return reply(io, command, "valid", 0, { illustrationId: record.illustrationId, operation: record.operation,
        digest: record.digest, source: record.source, characters: record.characters, style: record.style,
        metadataOnly: true }, json);
    } catch { return reply(io, command, "invalid-metadata", 1, null, json); }
  }
  const request = parsed.values.request;
  const directory = parsed.values["job-directory"];
  const timeout = parsed.values["timeout-ms"] ?? "300000";
  if (parsed.positionals.length || typeof request !== "string" || typeof directory !== "string" || typeof timeout !== "string"
      || !/^[1-9][0-9]*$/.test(timeout) || Number(timeout) > 300_000) return reply(io, command, "invalid-arguments", 1, null, json);
  let privateRequest: { prompt: string; referenceImagePaths: string[] };
  try {
    const path = resolve(cwd, request);
    const file = await readRegularFileSnapshot(path, { operation: "validate", domain: "cli" }, "ILLUSTRATION_REQUEST_INVALID", "Private request must be a bounded regular file.", 32_768);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
    if (text.startsWith("\uFEFF")) throw new Error();
    const value = parseDuplicateFreeJson(text, { operation: "validate", domain: "cli" });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || !Object.hasOwn(row, "prompt") || !Object.hasOwn(row, "referenceImagePaths")
        || typeof row.prompt !== "string" || !Array.isArray(row.referenceImagePaths)
        || !row.referenceImagePaths.every(p => typeof p === "string")) throw new Error();
    privateRequest = { prompt: row.prompt, referenceImagePaths: row.referenceImagePaths.map(p => resolve(dirname(path), p as string)) };
  } catch { return reply(io, command, "invalid-private-request", 1, null, json); }
  let result: NativeAgentResult;
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try { result = await dispatch({ ...privateRequest, operation: command, jobDirectory: resolve(cwd, directory), timeoutMs: Number(timeout) }, { signal: controller.signal }); }
  catch (error) {
    if (error instanceof NativeIllustrationAgentError) {
      return reply(io, command, error.dispatched ? "unknown" : "failed", 3, { failureCode: error.code }, json);
    }
    return reply(io, command, "unknown", 3, { failureCode: "INTERNAL_ERROR" }, json);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
  if (result.state !== "completed") return reply(io, command, result.state, 3, { failureCode: result.failureCode }, json);
  return reply(io, command, "completed", 0, { source: { filename: result.source.filename, sha256: result.source.sha256, bytes: result.source.bytes },
    provider: result.provider, model: result.model, imageDecoded: false, artisticAcceptance: "unreviewed" }, json);
}
