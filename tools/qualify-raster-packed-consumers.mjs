import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [baseArgument, companionArgument] = process.argv.slice(2);
if (baseArgument === undefined || companionArgument === undefined) throw new Error("Expected base and companion tarball paths.");
const baseTarball = resolve(baseArgument), companionTarball = resolve(companionArgument), repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "tfsb-raster-packed-"));

/** @param {string} file @param {string[]} args @param {string} cwd @param {number} [expected] @param {boolean} [denyNetwork] */
async function command(file, args, cwd, expected = 0, denyNetwork = false) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, npm_config_ignore_scripts: "true" };
  if (denyNetwork) {
    const preload = process.env.TFSB_NETWORK_DENIAL_PRELOAD;
    if (preload === undefined || preload === "") throw new Error("TFSB_NETWORK_DENIAL_PRELOAD is required for render qualification.");
    env.NODE_OPTIONS = `--import=${resolve(preload)}`;
  } else {
    delete env.NODE_OPTIONS;
  }
  try { const result = await execute(file, args, { cwd, env, maxBuffer: 16 * 1_048_576 }); if (expected !== 0) throw new Error(`Expected exit ${expected}.`); return { status: 0, ...result }; }
  catch (error) { if (!(error instanceof Error)) throw new Error("Non-error process failure."); const failure = /** @type {Error & {code?: number | string, stdout?: string, stderr?: string}} */ (error); const status = typeof failure.code === "number" ? failure.code : 1; if (status !== expected) throw error; return { status, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" }; }
}

const npmCmd = process.env.npm_execpath
  ? process.execPath
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
const npmBaseArgs = process.env.npm_execpath ? [process.env.npm_execpath] : [];

/** @param {string} consumer */
function cliInvocation(consumer) {
  return {
    exec: process.execPath,
    script: join(consumer, "node_modules/@knowledge-forge-ai/theme-forge-stellar-burst/dist/cli.js"),
  };
}

/** @param {string} name @param {boolean} withCompanion */
async function initializeConsumer(name, withCompanion) {
  const root = join(scratch, name); await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  await command(npmCmd, [...npmBaseArgs, "install", "--ignore-scripts", "--no-audit", "--no-fund", baseTarball, ...(withCompanion ? [companionTarball] : [])], root);
  return root;
}

/** @param {string} consumer @param {string} name @param {boolean} qa */
async function createProject(consumer, name, qa) {
  const root = join(consumer, name); await mkdir(join(root, ".tfsb", "assets"), { recursive: true }); await mkdir(join(root, ".tfsb", "companions"), { recursive: true });
  /** @param {string} path */
  const read = (path) => readFile(join(repo, path), "utf8");
  await writeFile(join(root, ".tfsb", "project.toml"), await read("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml"));
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-dark.toml"), await read("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml"));
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-light.toml"), await read("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml"));
  let brand = (await read("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml")).replace("exports = false", "exports = true"); if (qa) brand = brand.replace("qa = false", "qa = true");
  await writeFile(join(root, ".tfsb", "brand.toml"), brand);
  const exportsToml = `schema = "tfsb.brand-exports"\nschema_version = 1\n\n[[profiles]]\nid = "web-icons"\nadapter = "resvg-png-v1"\n\n[[profiles.outputs]]\nid = "icon"\npurpose = "pwa-icon"\nasset = "fixture-mark-on-light"\ndestination = "public/icon.png"\nwidth = 16\nheight = 16\nfit = "contain-pad"\nbackground = "transparent"\ncolor_space = "srgb"\nalpha = "straight"\n`;
  await writeFile(join(root, ".tfsb", "brand-exports.toml"), exportsToml);
  const api = await import(pathToFileURL(join(consumer, "node_modules/@knowledge-forge-ai/theme-forge-stellar-burst/dist/index.js")).href);
  const parsed = api.parseBrandExportsToml(exportsToml); if (!parsed.ok) throw new Error("Packed export fixture failed to parse.");
  const packageToml = (await read("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand-package.toml")).replace(/brand_system_digest = "[^"]+"/u, (line) => `${line}\nexport_profile_digest = "${api.computeBrandExportsDomainDigest(parsed.value)}"`);
  const guidance = await read("docs/examples/v0.4/brand-system/core-minimal/GUIDANCE.md"); await writeFile(join(root, ".tfsb", "brand-package.toml"), packageToml); await writeFile(join(root, ".tfsb", "companions", "GUIDANCE.md"), guidance); await writeFile(join(root, "GUIDANCE.md"), guidance);
  if (qa) await writeFile(join(root, ".tfsb", "brand-qa.toml"), `schema = "tfsb.brand-qa"\nschema_version = 1\n[[profiles]]\nid = "visual"\nrenderer = "required"\nformats = ["json"]\ncases = ["pixels"]\n[[cases]]\nid = "pixels"\nkind = "pixel-bounds"\nasset = "fixture-mark-on-light"\nsizes = [[16, 16]]\nbackgrounds = ["transparent"]\nalpha_threshold = 0\n`);
  return root;
}

try {
  const baseOnly = await initializeConsumer("base-only", false), baseCli = cliInvocation(baseOnly), baseProject = await createProject(baseOnly, "project", false);
  await command(baseCli.exec, [baseCli.script, "build"], baseProject, 0, true); const unavailable = await command(baseCli.exec, [baseCli.script, "export", "--profile", "web-icons", "--json"], baseProject, 3, true); if (!unavailable.stdout.includes("EXPORT_CAPABILITY_UNAVAILABLE")) throw new Error("Base-only export did not report capability unavailable.");
  const baseApi = await import(pathToFileURL(join(baseOnly, "node_modules/@knowledge-forge-ai/theme-forge-stellar-burst/dist/index.js")).href); if ((await baseApi.loadRasterCapability()).available) throw new Error("Base-only consumer loaded a renderer.");

  const enabled = await initializeConsumer("enabled", true), enabledCli = cliInvocation(enabled), enabledProject = await createProject(enabled, "project", true);
  await command(enabledCli.exec, [enabledCli.script, "build"], enabledProject, 0, true); await command(enabledCli.exec, [enabledCli.script, "export", "--profile", "web-icons", "--json"], enabledProject, 0, true); await command(enabledCli.exec, [enabledCli.script, "export", "--profile", "web-icons", "--json"], enabledProject, 0, true); await command(enabledCli.exec, [enabledCli.script, "check", "--json"], enabledProject, 0, true); await command(enabledCli.exec, [enabledCli.script, "list", "--json"], enabledProject, 0, true); await command(enabledCli.exec, [enabledCli.script, "qa", "--profile", "visual", "--json"], enabledProject, 0, true);
  await writeFile(join(enabledProject, "public", "icon.png"), "tamper"); await command(enabledCli.exec, [enabledCli.script, "export", "--profile", "web-icons", "--json"], enabledProject, 2, true);

  const corruptProject = await createProject(enabled, "corrupt-project", false); await command(enabledCli.exec, [enabledCli.script, "build"], corruptProject, 0, true); await rm(join(enabled, "node_modules/@resvg/resvg-wasm/index_bg.wasm")); const corrupt = await command(enabledCli.exec, [enabledCli.script, "export", "--profile", "web-icons", "--json"], corruptProject, 3, true); if (!corrupt.stdout.includes("EXPORT_CAPABILITY_UNAVAILABLE")) throw new Error("Corrupt renderer did not fail closed.");
  process.stdout.write(`${JSON.stringify({ baseOnly: "passed", companionEnabled: "passed", corruptRenderer: "passed", scriptsDisabled: true })}\n`);
} finally { await rm(scratch, { recursive: true, force: true }); }
