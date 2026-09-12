import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit caller-owned scratch destination; no publication or lifecycle scripts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = process.argv[2];
if (!destination) throw new Error("Supply an empty qualification scratch directory.");
const work = resolve(destination);
mkdirSync(work, { recursive: false });
const packDir = join(work, "pack");
const consumer = join(work, "consumer");
mkdirSync(packDir); mkdirSync(consumer);
/** @param {string} command @param {string[]} args @param {string} cwd */
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** @param {string | Uint8Array} bytes */
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @type {Array<{filename:string, files:Array<{path:string}>, entryCount:number}>} */
const packResults = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], root));
const pack = packResults[0]; assert(pack);
const packedTarball = join(packDir, pack.filename);
const tarball = process.argv[3] ? resolve(process.argv[3]) : packedTarball;
assert.equal(hash(readFileSync(tarball)), hash(readFileSync(packedTarball)), "Frozen artifact differs from qualified package bytes");
const members = pack.files.map(({ path }) => path).sort();
assert.equal(pack.entryCount, members.length);
assert(members.includes("dist/scene/index.js"));
assert(members.includes("dist/scene/index.d.ts"));
assert(members.includes("dist/scene/import-svg.js"));
assert(members.includes("dist/scene/import-svg.d.ts"));
assert(members.includes("protocol/tfsb-scene-v1/scene.schema.json"));
assert(members.some((path) => path.startsWith("dist/scene/glyphs/") && path.endsWith(".js")));

// Shipped historical fixtures inventory check
const historicalFixtures = [
  "scene-illustration.json",
  "scene-diagram.json",
  "scene-editorial.json",
  "scene-promotional.json",
  "scene-pattern.json",
  "scene-geometry.json",
  "scene-paint.json",
  "scene-labels.json",
].sort();

for (const name of historicalFixtures) {
  assert(members.includes(`protocol/tfsb-scene-v1/examples/${name}`), `Missing historical fixture member: ${name}`);
}

for (const path of members) {
  assert(!/(?:node_modules|cache|dogfood|\.serena|\.tgz)(?:\/|$)/i.test(path), `Unexpected member: ${path}`);
  assert(!/(?:^|\/)(?:test|tests|fixtures|corpus|art|artwork)(?:\/|$)/i.test(path), `Package inventory contains test art or test directories: ${path}`);
  assert(!/\.svg$/i.test(path), `Package inventory contains SVG artwork file: ${path}`);
  assert(/^(?:dist\/|protocol\/tfsb-(?:studio|design-evidence|scene)-v1\/|native\/directory-snapshot\/prebuilds\/|NOTICE$|COMMERCIAL-LICENSE.md$|LICENSE$|README.md$|package.json$)/.test(path), `Unexpected member: ${path}`);
}
writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }) + "\n");
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);
const packageRoot = join(consumer, "node_modules/@knowledge-forge-ai/theme-forge-stellar-burst");
const packageFile = join(packageRoot, "package.json");
const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
assert.equal(pkg.version, "0.5.0");
assert.deepEqual(pkg.dependencies, { "@xmldom/xmldom": "0.9.12", fflate: "0.8.3", "smol-toml": "1.8.0" });
assert.deepEqual(pkg.exports, {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
  },
  "./studio-protocol/v1": {
    "types": "./dist/service-protocol/v1-types.d.ts",
    "import": "./dist/service-protocol/v1-types.js",
  },
  "./design-evidence/v1": {
    "types": "./dist/design-evidence/index.d.ts",
    "import": "./dist/design-evidence/index.js",
  },
  "./scene/v1": {
    "types": "./dist/scene/index.d.ts",
    "import": "./dist/scene/index.js",
  },
});
for (const key of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts?.[key], undefined);
for (const path of members.filter((path) => /\.(?:js|json|md|ts)$/.test(path))) {
  assert(!/(?:\/Users\/|\/home\/[^/]+\/|projs\/dogfood)/.test(readFileSync(join(packageRoot, path), "utf8")), `Private path in ${path}`);
}

// Assert declarations export API
const sceneDts = readFileSync(join(packageRoot, "dist/scene/index.d.ts"), "utf8");
assert(/\bsceneImportSvg\b/.test(sceneDts), "dist/scene/index.d.ts does not export sceneImportSvg");
const importDts = readFileSync(join(packageRoot, "dist/scene/import-svg.d.ts"), "utf8");
assert(/\bsceneImportSvg\b/.test(importDts), "dist/scene/import-svg.d.ts does not export sceneImportSvg");

const fixtures = readdirSync(join(packageRoot, "protocol/tfsb-scene-v1/examples")).filter((name) => /^scene-(?:illustration|diagram|editorial|promotional|pattern|geometry|paint|labels)\.json$/.test(name)).sort();
assert.equal(fixtures.length, 8);
assert.deepEqual(fixtures, historicalFixtures);

const smoke = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as legacy from '@knowledge-forge-ai/theme-forge-stellar-burst';
import * as studio from '@knowledge-forge-ai/theme-forge-stellar-burst/studio-protocol/v1';
import * as evidence from '@knowledge-forge-ai/theme-forge-stellar-burst/design-evidence/v1';
import { validateScene, compileScene, sceneImportSvg } from '@knowledge-forge-ai/theme-forge-stellar-burst/scene/v1';
assert.equal(typeof legacy.parseSvg,'function'); assert(studio); assert(evidence);
assert.equal(typeof sceneImportSvg, 'function');
const fixtures = ${JSON.stringify(fixtures)};
const result = [];
for (const name of fixtures) {
 const scene = JSON.parse(readFileSync('./node_modules/@knowledge-forge-ai/theme-forge-stellar-burst/protocol/tfsb-scene-v1/examples/'+name,'utf8'));
 const validation = validateScene(scene); assert(validation.ok,JSON.stringify(validation));
 const first = compileScene(scene); assert(first.ok,JSON.stringify(first));
 assert.deepEqual(compileScene(scene), first);
 assert(!/<(?:text|tspan)\\b/.test(first.value.svg));
 result.push({name,svgDigest:createHash('sha256').update(first.value.svg).digest('hex'),receipt:first.value.receipt});
 for (const invalid of [{...scene,script:'bad'}, {...scene,elements:[{type:'use',id:'bad',href:'https://example.invalid/art.svg',width:10,height:10}]}, {...scene,elements:[{type:'use',id:'bad',href:'missing',width:10,height:10}]}]) assert.equal(validateScene(invalid).ok,false);
}
console.log(JSON.stringify(result));
`;
writeFileSync(join(consumer, "smoke.mjs"), smoke);
const before = run(process.execPath, ["smoke.mjs"], consumer);
pkg.version = "0.5.1";
writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + "\n");
assert.equal(run(process.execPath, ["smoke.mjs"], consumer), before, "Package patch changed scene evidence");
pkg.version = "0.5.0";
writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + "\n");
/** @type {Array<{name:string,svgDigest:string,receipt:any}>} */
const outputs = JSON.parse(before);
// Simulate a later compatible compiler in the installed package only. Saved
// level-1 documents retain their source identity; the receipt names the compiler.
const constantsFile = join(packageRoot, "dist/scene/constants.js");
const originalConstants = readFileSync(constantsFile, "utf8");
assert(originalConstants.includes("SCENE_COMPILER_LEVEL = 1;"));
try {
  writeFileSync(constantsFile, originalConstants.replace("SCENE_COMPILER_LEVEL = 1;", "SCENE_COMPILER_LEVEL = 2;"));
  const future = JSON.parse(run(process.execPath, ["smoke.mjs"], consumer));
  for (const [i, item] of future.entries()) {
    assert.equal(item.receipt.sceneCompilerLevel, 2);
    assert.equal(item.receipt.sourceDigest, outputs[i]?.receipt.sourceDigest);
    assert.equal(item.svgDigest, outputs[i]?.svgDigest);
  }
} finally {
  writeFileSync(constantsFile, originalConstants);
}
const cliPublication = true;
const cli = join(packageRoot, "dist/cli.js");
for (const { name, svgDigest } of outputs) {
  const input = join(packageRoot, "protocol/tfsb-scene-v1/examples", name);
  const output = join(consumer, name + ".svg");
  JSON.parse(run(process.execPath, [cli, "scene", "validate", input, "--json"], consumer));
  JSON.parse(run(process.execPath, [cli, "scene", "compile", input, "--output", output, "--dry-run", "--json"], consumer));
  JSON.parse(run(process.execPath, [cli, "scene", "compile", input, "--output", output, "--json"], consumer));
  assert.equal(hash(readFileSync(output)), svgDigest);
}

// Installed consumer import API qualification
const inlineShapeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect x="8" y="8" width="48" height="48" fill="#123456"/></svg>';
const importerSmoke = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateScene, compileScene, sceneImportSvg } from '@knowledge-forge-ai/theme-forge-stellar-burst/scene/v1';

/** @param {string | Uint8Array} bytes */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sampleSvg = ${JSON.stringify(inlineShapeSvg)};
const sampleBytes = new TextEncoder().encode(sampleSvg);

// Import API
const first = sceneImportSvg(sampleBytes);
assert.equal(first.classification, 'SUPPORTED_IMPORT');
assert(first.scene, 'Expected scene on SUPPORTED_IMPORT');
assert.equal(typeof first.canonicalScene, 'string');
assert.equal(first.sourceSha256, 'sha256:' + hash(sampleBytes));
assert(first.features && typeof first.features === 'object');
assert.equal(first.features.complete, true);
assert(Array.isArray(first.reasonCodes));
assert.equal(first.reasonCodes.length, 0);

// Validate and compile imported scene
const validation = validateScene(first.scene);
assert(validation.ok, JSON.stringify(validation));
const compiled = compileScene(first.scene);
assert(compiled.ok, JSON.stringify(compiled));
assert.equal(typeof compiled.value.svg, 'string');

// Repeated API byte identical scenes/SVG
const repeated = sceneImportSvg(sampleBytes);
assert.equal(repeated.classification, 'SUPPORTED_IMPORT');
assert.deepEqual(repeated.scene, first.scene);
assert.equal(repeated.canonicalScene, first.canonicalScene);
assert.equal(repeated.sourceSha256, first.sourceSha256);
const recompiled = compileScene(repeated.scene);
assert.deepEqual(recompiled, compiled);
assert.equal(recompiled.value.svg, compiled.value.svg);

// API denials: unsafe script, external href, unsupported class, unsupported text
const denials = [
  { name: 'unsafe-script', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script>alert(1)</script><rect width="10" height="10"/></svg>' },
  { name: 'external-href', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><use href="https://example.invalid/bad.svg#x"/><rect width="10" height="10"/></svg>' },
  { name: 'unsupported-class', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect class="fancy" width="10" height="10"/></svg>' },
  { name: 'unsupported-text', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="0" y="10">Hello</text></svg>' },
];

for (const { name, svg } of denials) {
  const result = sceneImportSvg(new TextEncoder().encode(svg));
  assert.notEqual(result.classification, 'SUPPORTED_IMPORT', 'API expected denial for ' + name);
  assert.equal(result.scene, undefined, 'API must not return scene on denial for ' + name);
}

console.log(JSON.stringify({
  classification: first.classification,
  sourceSha256: first.sourceSha256,
  canonicalSceneSha256: hash(new TextEncoder().encode(first.canonicalScene)),
  svgDigest: hash(new TextEncoder().encode(compiled.value.svg)),
  receipt: compiled.value.receipt,
  features: first.features,
  normalizations: first.normalizations,
  reasonCodes: first.reasonCodes,
}));
`;
writeFileSync(join(consumer, "smoke-importer.mjs"), importerSmoke);
const importerApiOutput = JSON.parse(run(process.execPath, ["smoke-importer.mjs"], consumer));

// Installed consumer CLI tests
const sampleSvgPath = join(consumer, "inline-shape.svg");
writeFileSync(sampleSvgPath, inlineShapeSvg);

// CLI two destinations identical JSON
const cliDest1 = join(consumer, "cli-import-dest1.json");
const cliDest2 = join(consumer, "cli-import-dest2.json");
const cliRun1 = run(process.execPath, [cli, "scene", "import-svg", sampleSvgPath, "--output", cliDest1, "--json"], consumer);
const cliRun2 = run(process.execPath, [cli, "scene", "import-svg", sampleSvgPath, "--output", cliDest2, "--json"], consumer);
const cliEnvelope1 = JSON.parse(cliRun1);
const cliEnvelope2 = JSON.parse(cliRun2);
assert.equal(cliEnvelope1.status, "ok");
assert.equal(cliEnvelope2.status, "ok");
assert.equal(cliEnvelope1.exitCode, 0);
assert.equal(cliEnvelope2.exitCode, 0);
assert.equal(cliEnvelope1.data?.classification, "SUPPORTED_IMPORT");
assert.equal(cliEnvelope2.data?.classification, "SUPPORTED_IMPORT");

assert(existsSync(cliDest1));
assert(existsSync(cliDest2));
const jsonDest1 = readFileSync(cliDest1, "utf8");
const jsonDest2 = readFileSync(cliDest2, "utf8");
assert.equal(jsonDest1, jsonDest2, "CLI two destinations must produce byte-identical JSON");
assert.equal(hash(Buffer.from(jsonDest1, "utf8")), importerApiOutput.canonicalSceneSha256);

// Validate and compile imported scene from CLI output
JSON.parse(run(process.execPath, [cli, "scene", "validate", cliDest1, "--json"], consumer));
const cliCompiledSvg = join(consumer, "cli-imported-compiled.svg");
JSON.parse(run(process.execPath, [cli, "scene", "compile", cliDest1, "--output", cliCompiledSvg, "--json"], consumer));
assert.equal(hash(readFileSync(cliCompiledSvg)), importerApiOutput.svgDigest);

// Existing target unchanged failure
const cliDest1Before = readFileSync(cliDest1, "utf8");
let existingTargetFailed = false;
try {
  const out = run(process.execPath, [cli, "scene", "import-svg", sampleSvgPath, "--output", cliDest1, "--json"], consumer);
  const parsed = JSON.parse(out);
  if (parsed.status === "error" || parsed.exitCode !== 0) existingTargetFailed = true;
} catch {
  existingTargetFailed = true;
}
assert(existingTargetFailed, "CLI import-svg must fail when target already exists");
assert.equal(readFileSync(cliDest1, "utf8"), cliDest1Before, "Existing target must remain unchanged on failure");

// Symlink failure
const symlinkTarget = join(consumer, "symlink-target.json");
const symlinkDest = join(consumer, "symlink-dest.json");
symlinkSync(symlinkTarget, symlinkDest);
let symlinkFailed = false;
try {
  const out = run(process.execPath, [cli, "scene", "import-svg", sampleSvgPath, "--output", symlinkDest, "--json"], consumer);
  const parsed = JSON.parse(out);
  if (parsed.status === "error" || parsed.exitCode !== 0) symlinkFailed = true;
} catch {
  symlinkFailed = true;
}
assert(symlinkFailed, "CLI import-svg must fail when destination is a symlink");
assert.equal(existsSync(symlinkTarget), false, "Symlink destination target must not be created");

// Unsafe script, external href, unsupported class, unsupported text rejection with no target
const cliDenials = [
  { name: "unsafe-script", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script>alert(1)</script><rect width="10" height="10"/></svg>' },
  { name: "external-href", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><use href="https://example.invalid/bad.svg#x"/><rect width="10" height="10"/></svg>' },
  { name: "unsupported-class", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect class="fancy" width="10" height="10"/></svg>' },
  { name: "unsupported-text", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="0" y="10">Hello</text></svg>' },
];

for (const { name, svg } of cliDenials) {
  const denialSvgPath = join(consumer, `${name}.svg`);
  writeFileSync(denialSvgPath, svg);
  const denialDestPath = join(consumer, `${name}-target.json`);
  let cliRejected = false;
  try {
    const out = run(process.execPath, [cli, "scene", "import-svg", denialSvgPath, "--output", denialDestPath, "--json"], consumer);
    const parsed = JSON.parse(out);
    if (parsed.status === "error" || parsed.exitCode !== 0 || parsed.data?.classification !== "SUPPORTED_IMPORT") {
      cliRejected = true;
    }
  } catch {
    cliRejected = true;
  }
  assert(cliRejected, `CLI import-svg expected rejection for ${name}`);
  assert.equal(existsSync(denialDestPath), false, `No target must be created on rejection for ${name}`);
}

const report = { schema: "tfsb.scene-package-qualification-v1", packageVersion: "0.4.0", tarballSha256: hash(readFileSync(tarball)), memberCount: members.length, members, installedConsumer: true, scriptsDisabled: true, patchIndependence: true, compilerLevelForwardAcceptance: true, cliPublication, fixtures: outputs, importer: { installedApi: true, classification: importerApiOutput.classification, sourceSha256: importerApiOutput.sourceSha256, canonicalSceneSha256: importerApiOutput.canonicalSceneSha256, svgDigest: importerApiOutput.svgDigest, receipt: importerApiOutput.receipt, features: importerApiOutput.features, normalizations: importerApiOutput.normalizations, reasonCodes: importerApiOutput.reasonCodes, cliPublication: true, deterministicJson: true, existingTargetGuarded: true, symlinkGuarded: true, rejectionsPassed: cliDenials.length } };
writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, members: undefined, fixtures: outputs.map(({ name, svgDigest }) => ({ name, svgDigest })) }, null, 2));
