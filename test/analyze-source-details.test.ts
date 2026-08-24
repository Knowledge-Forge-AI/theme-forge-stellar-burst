import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyze, executeCompleteAnalysis, inspectAnalyzeInput, planAnalyzeDetails, publishAnalyzeDetails, serializeAnalyzeDetailsLines, verifyAnalyzeInputPlan, type AnalyzeDetailsHooks } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" role="img" aria-labelledby="t d"><title id="t">T</title><desc id="d">D</desc><path d="M0 0L1 1"/></svg>';
async function root(): Promise<string> { const value = await realpath(await mkdtemp(join(tmpdir(), "tfsb-analyze-source-"))); roots.push(value); return value; }

describe("analyze directory snapshots", () => {
  it("walks by portable UTF-8 order and never mutates source", async () => {
    const directory = await root(); await writeFile(join(directory, "z.svg"), source); await writeFile(join(directory, "A.svg"), source);
    const before = await Promise.all(["z.svg", "A.svg"].map(async (name) => [name, await readFile(join(directory, name)), await lstat(join(directory, name))] as const));
    const result = await analyze({ input: directory });
    expect(result.files.map((file) => file.path)).toEqual(["A.svg", "z.svg"]);
    for (const [name, bytes, stat] of before) { expect(await readFile(join(directory, name))).toEqual(bytes); expect((await lstat(join(directory, name))).mtimeMs).toBe(stat.mtimeMs); }
  });

  it.each(["file", "directory"])("rejects a %s symlink candidate", async (kind) => {
    const directory = await root(); const target = join(directory, "target");
    if (kind === "file") await writeFile(target, source); else await mkdir(target);
    await symlink(target, join(directory, kind === "file" ? "linked.svg" : "linked"));
    await expect(inspectAnalyzeInput(directory)).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_SNAPSHOT_FAILED" } });
  });

  it("rejects an input path that crosses an intermediate symlink", async () => {
    const directory = await root(); const real = join(directory, "real"); await mkdir(real); await writeFile(join(real, "a.svg"), source); await symlink(real, join(directory, "alias"));
    await expect(inspectAnalyzeInput(join(directory, "alias"))).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_INPUT_INVALID" } });
  });

  it("invalidates the accepted plan when a file or visited inventory changes", async () => {
    const directory = await root(); await writeFile(join(directory, "a.svg"), source); const plan = await inspectAnalyzeInput(directory);
    await writeFile(join(directory, "a.svg"), `${source}\n`);
    await expect(verifyAnalyzeInputPlan(plan)).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_SOURCE_CHANGED" } });
    const second = await inspectAnalyzeInput(directory); await writeFile(join(directory, "later.txt"), "x");
    await expect(executeCompleteAnalysis(second)).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_SOURCE_CHANGED" } });
  });
});

describe("details NDJSON publication", () => {
  async function planned() { const directory = await root(); await writeFile(join(directory, "a.svg"), source); const plan = await inspectAnalyzeInput(directory); const result = await executeCompleteAnalysis(plan); const out = await root(); return { directory, plan, result, out, target: join(out, "details.ndjson") }; }

  it("publishes canonical mode-0600 NDJSON with a verified digest and no temp residue", async () => {
    const value = await planned(); const publication = await publishAnalyzeDetails(await planAnalyzeDetails(value.plan, value.target), value.result);
    expect(publication.published).toBe(true); expect((await lstat(value.target)).mode & 0o777).toBe(0o600);
    const lines = (await readFile(value.target, "utf8")).split(/(?<=\n)/).filter(Boolean);
    expect(lines).toEqual(serializeAnalyzeDetailsLines(value.result));
    expect((await readdir(value.out)).sort()).toEqual(["details.ndjson"]);
  });

  it("rejects relative escape, parent symlinks, existing targets, and targets within analyzed input", async () => {
    const value = await planned();
    await expect(planAnalyzeDetails(value.plan, "../escape.ndjson")).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_DETAILS_TARGET_INVALID" } });
    await writeFile(value.target, "existing"); await expect(planAnalyzeDetails(value.plan, value.target)).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_DETAILS_TARGET_INVALID" } });
    await rm(value.target); await expect(planAnalyzeDetails(value.plan, join(value.directory, "inside.ndjson"))).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_DETAILS_TARGET_INVALID" } });
    const linkParent = join(value.out, "linked"); await symlink(value.out, linkParent);
    await expect(planAnalyzeDetails(value.plan, join(linkParent, "x.ndjson"))).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_DETAILS_TARGET_INVALID" } });
  });

  it("allows analyzing dot with an absolute sibling target", async () => {
    const value = await planned(); const dotPlan = await inspectAnalyzeInput(".", value.directory);
    const sibling = join(value.out, "sibling.ndjson"); await expect(planAnalyzeDetails(dotPlan, sibling)).resolves.toMatchObject({ targetPath: sibling });
  });

  it("applies configured project policy only when discoverable from invocation cwd", async () => {
    const project = await root(); await mkdir(join(project, ".tfsb")); await mkdir(join(project, "nested")); await mkdir(join(project, "docs"));
    await writeFile(join(project, ".tfsb", "project.toml"), 'schema_version = 1\nname = "Policy"\nbuild_directory = "build"\n\n[[install]]\nasset = "a"\ndestinations = ["static/a.svg"]\n\n[[companion]]\nfile = "README.md"\ndestinations = ["README-BRAND.md"]\n');
    const sourceRoot = await root(); await writeFile(join(sourceRoot, "a.svg"), source); const discovered = await inspectAnalyzeInput(sourceRoot, join(project, "nested"));
    for (const target of [join(project, ".tfsb", "details.ndjson"), join(project, ".tfsb-preview", "details.ndjson"), join(project, "build", "details.ndjson"), join(project, "static", "a.svg"), join(project, "README-BRAND.md"), join(project, "docs", "details.ndjson")]) await expect(planAnalyzeDetails(discovered, target)).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_DETAILS_TARGET_INVALID" } });

    const analyzedProjectSubtree = join(project, "corpus"); await mkdir(analyzedProjectSubtree); await writeFile(join(analyzedProjectSubtree, "a.svg"), source);
    const unrelatedCwd = await root(); const notDiscovered = await inspectAnalyzeInput(analyzedProjectSubtree, unrelatedCwd);
    await expect(planAnalyzeDetails(notDiscovered, join(project, "docs", "allowed.ndjson"))).resolves.toMatchObject({ targetPath: join(project, "docs", "allowed.ndjson") });
  });

  const prePublicationBoundaries: (keyof AnalyzeDetailsHooks)[] = ["beforeCreate", "afterCreate", "beforeWrite", "afterWrite", "beforeTempSync", "beforeTempClose", "beforeInputRevalidation", "beforeParentRevalidation", "beforeTargetRevalidation", "beforeLink"];
  it.each(prePublicationBoundaries)("cleans its exact temp and publishes no bytes when %s fails", async (boundary) => {
    const value = await planned(); const hooks = { [boundary]: () => { throw new Error("injected"); } } as AnalyzeDetailsHooks;
    await expect(publishAnalyzeDetails(await planAnalyzeDetails(value.plan, value.target), value.result, hooks)).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_DETAILS_WRITE_FAILED" } });
    await expect(access(value.target)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readdir(value.out)).toEqual([]);
  });

  it.each(["afterLink", "beforeParentSync", "beforeTempRemoval", "afterTempRemoval", "beforeFinalParentSync"] as const)("retains the complete no-overwrite target when %s fails after publication", async (boundary) => {
    const value = await planned(); const hooks = { [boundary]: () => { throw new Error("injected"); } } as AnalyzeDetailsHooks;
    await expect(publishAnalyzeDetails(await planAnalyzeDetails(value.plan, value.target), value.result, hooks)).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_DETAILS_WRITE_FAILED" } });
    expect(await readFile(value.target, "utf8")).toBe(serializeAnalyzeDetailsLines(value.result).join(""));
  });

  it("fails closed if the target appears between planning and hard-link publication", async () => {
    const value = await planned(); const plan = await planAnalyzeDetails(value.plan, value.target);
    await expect(publishAnalyzeDetails(plan, value.result, { beforeInputRevalidation: async () => { await writeFile(value.target, "racer"); } })).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_DETAILS_TARGET_INVALID" } });
    expect(await readFile(value.target, "utf8")).toBe("racer");
  });

  it("reports exact temp residue when post-link transaction cleanup fails", async () => {
    const value = await planned();
    const plan = await planAnalyzeDetails(value.plan, value.target);
    await expect(publishAnalyzeDetails(plan, value.result, {
      afterLink: () => { throw new Error("post-link failure"); },
    })).rejects.toThrow(/residue:/);
    expect(await readFile(value.target, "utf8")).toBe(serializeAnalyzeDetailsLines(value.result).join(""));
  });
});

