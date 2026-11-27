import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parseDuplicateFreeJson } from "../brand/consumer-lock.js";
import { durableWrite } from "../filesystem.js";
import { createIllustrationConsumerProfile, serializeIllustrationConsumerProfile } from "./carrier-v1.js";
import { disposeIllustrationSource, verifyIllustrationSource } from "./carrier-source.js";
import { writeIllustrationCarrier } from "./carrier-write.js";
import { validateCarrierDerivativeRecipe } from "./derivative.js";
import {
  disposeIllustrationPlan, executeIllustrationInstallPlan, ILLUSTRATION_PROFILE_FILENAME, planIllustrationInstall,
} from "./consumer-plan.js";
import {
  closeIllustrationDirectories, retainIllustrationDirectories, retainIllustrationFile, verifyIllustrationDirectories,
} from "./retained-files.js";
import { parseRasterIllustration } from "./v1.js";

interface Io { stdout(text: string): void; stderr(text: string): void }
const COMMANDS = new Set(["carrier-create", "carrier-inspect", "carrier-verify-svg", "consumer-init", "consumer-plan", "install", "sync"]);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

async function readInput(path: string, limit: number): Promise<Uint8Array> {
  const directories = await retainIllustrationDirectories(dirname(path));
  try {
    const file = await retainIllustrationFile(path, limit);
    try { await verifyIllustrationDirectories(directories); return new Uint8Array(file.bytes); }
    finally { await file.handle.close(); }
  } finally { await closeIllustrationDirectories(directories); }
}

function jsonInput(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.startsWith("\uFEFF")) throw new Error();
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") { if (++depth > 32) throw new Error(); }
    else if (char === "}" || char === "]") { if (--depth < 0) throw new Error(); }
  }
  return parseDuplicateFreeJson(text, { operation: "validate", domain: "cli" });
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error();
  return value as Record<string, unknown>;
}

export async function runIllustrationConsumerCli(argv: readonly string[], cwd: string, io: Io): Promise<number> {
  const [command, ...rest] = argv; const json = argv.includes("--json");
  const reply = (state: string, exitCode: number, data: unknown): number => {
    if (json) io.stdout(JSON.stringify({ schema: "tfsb.illustration-consumer-result", schemaVersion: 1, command, state, exitCode, data }, null, 2) + "\n");
    else if (exitCode === 0) io.stdout(`Illustration ${command}: ${state}.\n`);
    else {
      const code = data && typeof data === "object" && "failureCode" in data
        && typeof data.failureCode === "string" && ERROR_CODE.test(data.failureCode) ? ` (${data.failureCode})` : "";
      io.stderr(`Illustration consumer operation failed${code}; inputs and private paths withheld.\n`);
    }
    return exitCode;
  };
  if (!command || !COMMANDS.has(command)) return reply("invalid-arguments", 1, null);
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    const parsed = parseArgs({ args: rest, strict: true, allowPositionals: false, options: {
      json: { type: "boolean" }, root: { type: "string" }, carrier: { type: "string" }, directory: { type: "string" },
      request: { type: "string" }, id: { type: "string" }, mapping: { type: "string", multiple: true }, operation: { type: "string" },
      package: { type: "string" }, illustration: { type: "string" }, svg: { type: "string" }, "compact-paths": { type: "boolean" },
      "compare-local-encoder": { type: "boolean" },
    } });
    values = parsed.values;
    const allowed: Record<string, readonly string[]> = {
      "carrier-create": ["json", "request", "directory"], "carrier-inspect": ["json", "directory"],
      "carrier-verify-svg": ["json", "directory", "svg", "compact-paths", "compare-local-encoder"],
      "consumer-init": ["json", "root", "id", "package", "illustration", "mapping"], "consumer-plan": ["json", "root", "carrier", "operation"],
      install: ["json", "root", "carrier"], sync: ["json", "root", "carrier"],
    };
    if (Object.keys(values).some(key => !allowed[command]!.includes(key))) throw new Error();
  } catch { return reply("invalid-arguments", 1, null); }
  const path = (value: unknown): string => { if (typeof value !== "string" || !value) throw new Error(); return resolve(cwd, value); };
  try {
    if (command === "carrier-create") {
      const requestPath = path(values.request);
      const request = object(jsonInput(await readInput(requestPath, 32768)), ["packageId", "revision", "recordPath", "derivatives"]);
      if (typeof request.packageId !== "string" || typeof request.revision !== "number" || typeof request.recordPath !== "string"
          || !Array.isArray(request.derivatives) || request.derivatives.length < 1 || request.derivatives.length > 16) throw new Error();
      const record = parseRasterIllustration(await readInput(resolve(dirname(requestPath), request.recordPath), 1048576));
      const derivatives = [];
      for (const item of request.derivatives) {
        const row = object(item, ["recipePath", "sourcePath"]);
        if (typeof row.recipePath !== "string" || typeof row.sourcePath !== "string") throw new Error();
        const recipe = validateCarrierDerivativeRecipe(jsonInput(await readInput(resolve(dirname(requestPath), row.recipePath), 262144)));
        const bytes = await readInput(resolve(dirname(requestPath), row.sourcePath), 32 * 1048576);
        derivatives.push({ recipe, bytes });
      }
      const result = await writeIllustrationCarrier({ directory: path(values.directory), packageId: request.packageId,
        revision: request.revision, record, derivatives });
      return reply("created", 0, { ...result, providerRequests: 0, masterEntrySlot: false });
    }
    if (command === "carrier-inspect") {
      const source = await verifyIllustrationSource(path(values.directory));
      try { return reply("verified", 0, { manifest: source.manifest, recordDigest: source.record.digest, providerRequests: 0 }); }
      finally { await disposeIllustrationSource(source); }
    }
    if (command === "carrier-verify-svg") {
      const { verifyIllustrationCarrierSvg } = await import("./carrier-svg.js");
      const compare = values["compare-local-encoder"] === true;
      const compactPaths = values["compact-paths"] === true ? true : undefined;
      const proof = await verifyIllustrationCarrierSvg(path(values.directory), path(values.svg), compactPaths, compare);
      return reply(compare ? "compared" : "verified", 0, { ...proof, providerRequests: 0 });
    }
    if (command === "consumer-init") {
      if (typeof values.id !== "string" || typeof values.package !== "string" || typeof values.illustration !== "string"
          || !Array.isArray(values.mapping) || values.mapping.some(value => typeof value !== "string")) throw new Error();
      const mappings = (values.mapping as string[]).map(value => {
        const index = value.indexOf("="); if (index < 1) throw new Error();
        return { derivativeId: value.slice(0, index), destination: value.slice(index + 1) };
      });
      const profile = createIllustrationConsumerProfile({ id: values.id, packageId: values.package, illustrationId: values.illustration, mappings });
      const root = path(values.root); const directories = await retainIllustrationDirectories(root);
      try { await verifyIllustrationDirectories(directories);
        await durableWrite(join(root, ILLUSTRATION_PROFILE_FILENAME), Buffer.from(serializeIllustrationConsumerProfile(profile)));
        await verifyIllustrationDirectories(directories); }
      finally { await closeIllustrationDirectories(directories); }
      return reply("configured", 0, { profileDigest: profile.profileDigest, mappings: profile.mappings, publication: false });
    }
    const operation = command === "consumer-plan" ? values.operation ?? "install" : command;
    if (operation !== "install" && operation !== "sync") throw new Error();
    const plan = await planIllustrationInstall({ root: path(values.root), sourceDirectory: path(values.carrier), operation });
    if (command === "consumer-plan") {
      try { return reply("planned", 0, { plan, serializedPlanIsExecutionAuthority: false, providerRequests: 0 }); }
      finally { await disposeIllustrationPlan(plan); }
    }
    const result = await executeIllustrationInstallPlan(plan);
    return reply(result.changed ? "installed" : "unchanged", 0, { ...result, providerRequests: 0, publication: false });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && ERROR_CODE.test(error.code)
      ? error.code : error && typeof error === "object" && "diagnostic" in error && error.diagnostic && typeof error.diagnostic === "object"
        && "code" in error.diagnostic && typeof error.diagnostic.code === "string" && ERROR_CODE.test(error.diagnostic.code)
        ? error.diagnostic.code : "ILLUSTRATION_INPUT_INVALID";
    return reply("failed", 3, { failureCode: code, partialCarrierPossible: code === "ILLUSTRATION_CARRIER_WRITE_FAILED", providerRequests: 0 });
  }
}
