// @ts-check

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @param {Uint8Array} bytes */
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {string} value */
function portable(value) {
  return value.replace(/\\/gu, "/");
}

/** @param {string} path @returns {Promise<string[]>} */
async function regularFiles(path) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Artifact symlink is forbidden: ${entry.name}`);
    if (entry.isDirectory()) output.push(...await regularFiles(full));
    else if (entry.isFile()) output.push(full);
    else throw new Error(`Non-regular artifact is forbidden: ${entry.name}`);
  }
  return output;
}

/** @param {string} path @param {string} requirement */
function matches(path, requirement) {
  if (requirement.startsWith("*")) return path.endsWith(requirement.slice(1));
  if (requirement.endsWith("*")) return path.startsWith(requirement.slice(0, -1));
  return path === requirement;
}

/**
 * @param {{rootDir: string, outputPath: string, jobName: string, matrix?: Record<string, string>, required?: string[]}} options
 */
export async function createArtifactManifest(options) {
  const root = resolve(options.rootDir);
  const outputPath = resolve(options.outputPath);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Artifact root must be a regular directory.");
  const files = (await regularFiles(root)).filter((path) => resolve(path) !== outputPath).sort();
  const artifacts = [];
  for (const path of files) {
    const bytes = await readFile(path);
    if (bytes.byteLength === 0) throw new Error(`Artifact is empty: ${portable(relative(root, path))}`);
    artifacts.push({ path: portable(relative(root, path)), size: bytes.byteLength, sha256: sha256Hex(bytes) });
  }
  for (const requirement of options.required ?? []) {
    if (!artifacts.some((artifact) => matches(artifact.path, requirement))) {
      throw new Error(`Required artifact is missing: ${requirement}`);
    }
  }
  const manifest = {
    schema: "tfsb.ci-job-artifact-manifest",
    schemaVersion: 1,
    status: "pass",
    job: options.jobName,
    matrix: options.matrix ?? {},
    generatedAt: new Date().toISOString(),
    artifacts,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/** Validate every member before extracting a release archive into empty scratch.
 * @param {{archivePath: string, destination: string, stripComponents?: number, manifestPath?: string, expectedSha256?: string}} options
 */
export async function extractReleaseArchive(options) {
  const archive = resolve(options.archivePath), destination = resolve(options.destination);
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error("Release archive must be a regular file.");
  const digest = sha256Hex(await readFile(archive));
  let expected = options.expectedSha256;
  if (options.manifestPath) {
    const manifestPath = resolve(options.manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const member = manifest.artifacts?.find((/** @type {any} */ item) => item.path === portable(relative(dirname(manifestPath), archive)));
    if (manifest.schema !== "tfsb.ci-job-artifact-manifest" || manifest.status !== "pass" || !member) throw new Error("Archive is absent from its producer manifest.");
    expected = member.sha256;
  }
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected) || digest !== expected) throw new Error("Release archive digest mismatch.");
  const strip = options.stripComponents ?? 0;
  if (![0, 1].includes(strip)) throw new Error("Only zero or one release archive prefix may be stripped.");
  execFileSync("python3", ["-c", String.raw`
import os,pathlib,shutil,sys,tarfile,unicodedata
archive,dest,strip=sys.argv[1],pathlib.Path(sys.argv[2]),int(sys.argv[3])
for parent in [dest,*dest.parents]:
 if parent.is_symlink() and not (str(parent) in ("/var","/tmp") and os.path.realpath(parent)=="/private"+str(parent)): raise ValueError("archive destination has a symlink ancestor")
if dest.exists() and (not dest.is_dir() or any(dest.iterdir())): raise ValueError("archive destination must be empty")
with tarfile.open(archive,"r:gz") as tf:
 entries=[]; seen=set()
 for member in tf.getmembers():
  name=member.name
  if name.startswith("./"): name=name[2:]
  if name in ("", ".") and member.isdir(): continue
  parts=name.rstrip("/").split("/")
  if name.startswith("/") or chr(92) in name or ":" in name or any(p in ("", ".", "..") for p in parts) or name!=unicodedata.normalize("NFC",name): raise ValueError("unsafe archive member path")
  if not (member.isfile() or member.isdir()): raise ValueError("archive links and special entries are forbidden")
  parts=parts[strip:]
  if not parts:
   if member.isdir(): continue
   raise ValueError("archive member loses its filename")
  key="/".join(parts).casefold()
  if key in seen: raise ValueError("duplicate archive member")
  seen.add(key)
  if member.mode & 0o7000 or (member.isfile() and member.mode & 0o777 not in (0o600,0o644,0o700,0o755)): raise ValueError("unowned archive member mode")
  entries.append((member,dest.joinpath(*parts)))
 # Validate file/directory collisions before any writes.
 files={p for m,p in entries if m.isfile()}
 if any(any(parent in files for parent in p.parents) for _,p in entries): raise ValueError("archive file/directory collision")
 dest.mkdir(parents=True,exist_ok=True)
 for member,path in entries:
  if member.isdir(): path.mkdir(parents=True,exist_ok=True); continue
  path.parent.mkdir(parents=True,exist_ok=True)
  with tf.extractfile(member) as src, path.open("xb") as out: shutil.copyfileobj(src,out)
  path.chmod(member.mode & 0o777)
`, archive, destination, String(strip)], { stdio: "pipe" });
  return { archiveSha256: digest, status: "pass" };
}

const invokedDirectly = process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes("--archive")) {
    const values = new Map();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1];
      if (!flag || !["--archive", "--extract-to", "--strip-components", "--manifest", "--sha256"].includes(flag) || !value || values.has(flag)) throw new Error("Invalid archive extraction argument.");
      values.set(flag, value);
    }
    if (!values.has("--archive") || !values.has("--extract-to")) throw new Error("--archive and --extract-to required.");
    await extractReleaseArchive({ archivePath: values.get("--archive"), destination: values.get("--extract-to"), stripComponents: Number(values.get("--strip-components") ?? 0), ...(values.has("--manifest") ? { manifestPath: values.get("--manifest") } : {}), ...(values.has("--sha256") ? { expectedSha256: values.get("--sha256") } : {}) });
  } else {
  let rootDir;
  let outputPath;
  let jobName;
  /** @type {Record<string, string>} */
  let matrix = {};
  const required = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--require" && value) { required.push(value); index += 1; }
    else if (flag === "--root" && value) { rootDir = value; index += 1; }
    else if (flag === "--output" && value) { outputPath = value; index += 1; }
    else if (flag === "--job" && value) { jobName = value; index += 1; }
    else if (flag === "--matrix-json" && value) {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--matrix-json must contain an object.");
      matrix = Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
      index += 1;
    }
    else if (flag === "--matrix" && value) {
      const separator = value.indexOf("=");
      if (separator < 1) throw new Error("--matrix requires key=value.");
      matrix[value.slice(0, separator)] = value.slice(separator + 1);
      index += 1;
    }
    else throw new Error(`Unsupported or incomplete artifact-manifest argument: ${flag}`);
  }
  if (!rootDir || !outputPath || !jobName) throw new Error("--root, --output, and --job are required.");
  createArtifactManifest({ rootDir, outputPath, jobName, matrix, required })
    .then((manifest) => process.stdout.write(`${JSON.stringify(manifest)}\n`))
    .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
}
