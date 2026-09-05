import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile), worker = new URL("./raster-qualification-worker.mjs", import.meta.url);
const args = process.argv.slice(2);
if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Raster execution requires Node major 22.");
if (args.length !== 2 || args[0] !== "--expected-tuple" || !["darwin-arm64", "darwin-x64", "linux-x64-gnu", "windows-x64"].includes(args[1] ?? "")) throw new Error("An explicit closed --expected-tuple is required.");
const corpusBytes = await readFile(new URL("../test/fixtures/raster-golden/corpus.json", import.meta.url));
/** @param {Uint8Array} bytes */
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** @type {readonly (readonly [string, string])[]} */
const environments = [
  ["UTC", "C"], ["America/New_York", "en_US.UTF-8"], ["Europe/Berlin", "C"], ["Asia/Tokyo", "en_US.UTF-8"], ["Pacific/Auckland", "C"],
  ["UTC", "en_US.UTF-8"], ["America/Los_Angeles", "C"], ["Europe/London", "en_US.UTF-8"], ["Asia/Kolkata", "C"], ["Australia/Sydney", "en_US.UTF-8"],
];
/** @type {{timezone: string, locale: string, elapsedMs: number, value: any}[]} */
const runs = [];
for (const [timezone, locale] of environments) {
  const started = performance.now();
  const { stdout } = await execute(process.execPath, [fileURLToPath(worker)], { env: { ...process.env, TZ: timezone, LANG: locale, LC_ALL: locale }, maxBuffer: 16 * 1_048_576 });
  runs.push({ timezone, locale, elapsedMs: Math.round(performance.now() - started), value: JSON.parse(stdout) });
}
const first = runs[0]; if (first === undefined) throw new Error("Raster qualification produced no runs.");
const reference = JSON.stringify(first.value.matrix);
if (runs.some((run) => JSON.stringify(run.value.matrix) !== reference)) throw new Error("Raster qualification matrix is not byte deterministic across clean processes.");
const descriptor = first.value.descriptor;
if (descriptor.platformClaim !== args[1]) throw new Error("Raster runtime does not match the expected tuple.");
const binding = { corpusDigest: sha(corpusBytes), companionPackage: descriptor.companionPackage, companionVersion: descriptor.companionVersion, backend: descriptor.backend, rendererPackage: descriptor.rendererPackage, rendererVersion: descriptor.rendererVersion, rendererBuildDigest: descriptor.rendererBuildDigest, nodeMajor: descriptor.nodeMajor, platformClaim: descriptor.platformClaim, matrix: first.value.matrix };
const qualificationId = sha(Buffer.from(JSON.stringify(binding)));
const manifest = { schema: "tfsb.raster-qualification", schemaVersion: 1, qualificationId, repetitions: runs.length, environments: runs.map(({ timezone, locale }) => ({ timezone, locale })), ...binding };
const expected = JSON.parse(await readFile(new URL("../docs/evaluations/v0.4-tfsb47f-raster-qualification.json", import.meta.url), "utf8"));
const straight = JSON.parse(await readFile(new URL("../test/fixtures/raster-golden/straight-alpha-digests.json", import.meta.url), "utf8"));
if (straight.schema !== "tfsb.raster-straight-alpha-golden-v1" || straight.corpusDigest !== manifest.corpusDigest || straight.historicalQualificationId !== expected.qualificationId || descriptor.qualificationId !== expected.qualificationId) throw new Error("Raster reference identities disagree.");
if (straight.cases.length !== expected.matrix.length || straight.cases.some((/** @type {any} */ item, /** @type {number} */ index) => item.id !== expected.matrix[index].id)) throw new Error("Straight-alpha reference cases disagree.");
// The historical record used premultiplied RGBA. Keep that record and the
// established runtime/protocol ID intact; qualify the accepted R2D straight
// buffer against its own golden digests and every unchanged PNG reference.
const currentExpected = { ...expected, qualificationId, platformClaim: descriptor.platformClaim,
  matrix: expected.matrix.map((/** @type {any} */ item, /** @type {number} */ index) => ({ ...item, decodedPixelDigest: straight.cases[index].decodedPixelDigest })) };
if (JSON.stringify(manifest) !== JSON.stringify(currentExpected)) throw new Error("Raster qualification differs from the exact PNG/straight-alpha golden matrix.");
process.stdout.write(`${JSON.stringify({ qualificationId: descriptor.qualificationId, executionQualificationId: qualificationId, historicalReferencePlatform: expected.platformClaim, repetitions: runs.length, executionTimeMs: runs.map(({ elapsedMs }) => elapsedMs), corpusCases: manifest.matrix.length, platformClaim: manifest.platformClaim })}\n`);
