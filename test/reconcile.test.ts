import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { importProject } from "../src/importer.js";
import { computeSha256 } from "../src/digests.js";
import { diffProject } from "../src/diff.js";
import {
  executeReconciliationPlan,
  planReconciliation,
  planReconciliationWithHooks,
  reconcileProject,
} from "../src/reconcile.js";

const roots: string[] = [];
const markName = "theme-forge-terminal-nova-mark-on-light.svg";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "tfsb-reconcile-"));
  roots.push(value);
  return value;
}

async function production(name: string): Promise<Uint8Array> {
  return readFile(join(process.cwd(), "test/fixtures/tftn-production-v1", name));
}

function editSvg(bytes: Uint8Array, suffix: string): Uint8Array {
  const text = Buffer.from(bytes).toString("utf8");
  return Buffer.from(text.replace("</title>", ` ${suffix}</title>`), "utf8");
}

async function archive(projectRoot: string, name: string, files: Record<string, Uint8Array>): Promise<string> {
  const path = join(projectRoot, name);
  await writeFile(path, zipSync(files, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
  return path;
}

async function imported(recordProvenance = true, names: readonly string[] = [markName]) {
  const projectRoot = await root();
  const files: Record<string, Uint8Array> = {};
  for (const name of names) files[name] = await production(name);
  const source = await archive(projectRoot, "source.zip", files);
  await importProject({ archive: source, root: projectRoot, schema: 1, recordProvenance });
  return { projectRoot, source, files };
}

async function canonicalBytes(projectRoot: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const directory of ["", "assets", "companions"]) {
    const path = join(projectRoot, ".tfsb", directory);
    for (const name of await readdir(path).catch(() => [])) {
      const full = join(path, name);
      const bytes = await readFile(full).catch(() => undefined);
      if (bytes !== undefined) result.set(`${directory}/${name}`, bytes);
    }
  }
  return result;
}

describe("bounded reconciliation", () => {
  it("keeps a tracked matching archive byte-identical with zero writes", async () => {
    const { projectRoot, source } = await imported();
    const provenanceText = await readFile(join(projectRoot, ".tfsb/provenance.json"), "utf8");
    expect(provenanceText).not.toContain(projectRoot);
    expect(provenanceText).not.toContain(source);
    const before = await canonicalBytes(projectRoot);
    const result = await reconcileProject({ archive: source, root: projectRoot, apply: true });
    expect(result.records.map((item) => item.classification)).toEqual(["UNCHANGED"]);
    expect(result.applied).toBe(false);
    expect(await canonicalBytes(projectRoot)).toEqual(before);
  });

  it("applies aligned changes and blocks the whole apply when any other record conflicts", async () => {
    const second = "favicon-on-light.svg";
    const { projectRoot, files } = await imported(true, [markName, second]);
    const markToml = join(projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml");
    await writeFile(markToml, (await readFile(markToml, "utf8")).replace("mark for light surfaces", "human canonical mark"));
    const candidate = await archive(projectRoot, "candidate.zip", {
      [markName]: editSvg(files[markName]!, "archive change"),
      [second]: editSvg(files[second]!, "safe incoming change"),
    });
    const before = await canonicalBytes(projectRoot);
    const result = await reconcileProject({ archive: candidate, root: projectRoot, apply: true });
    expect(result.blocked).toBe(true);
    expect(result.records.map((item) => item.classification)).toEqual(["ARCHIVE_CHANGED", "CONFLICT"]);
    expect(await canonicalBytes(projectRoot)).toEqual(before);
  });

  it("rejects public plan mutation and derives blockers from private planner state", async () => {
    const second = "favicon-on-light.svg";
    const { projectRoot, files } = await imported(true, [markName, second]);
    const markToml = join(projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml");
    await writeFile(markToml, (await readFile(markToml, "utf8")).replace("mark for light surfaces", "human edit"));
    const candidate = await archive(projectRoot, "blocked.zip", {
      [markName]: editSvg(files[markName]!, "archive edit"),
      [second]: editSvg(files[second]!, "safe edit"),
    });
    const plan = await planReconciliation({ archive: candidate, root: projectRoot });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.records)).toBe(true);
    expect(plan.records.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(plan as any, "blocked", false)).toBe(false);
    expect(Reflect.set(plan as any, "changed", false)).toBe(false);
    expect(Reflect.set(plan.records[0] as any, "blocker", false)).toBe(false);
    await expect(executeReconciliationPlan(plan))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_UNRESOLVED" } });
  });

  it("rejects forged and cloned plans while valid clean and changed plans execute", async () => {
    const clean = await imported();
    const cleanPlan = await planReconciliation({ archive: clean.source, root: clean.projectRoot });
    await expect(executeReconciliationPlan({ ...cleanPlan } as any))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_INVALID_PLAN" } });
    await expect(executeReconciliationPlan(structuredClone(cleanPlan) as any))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_INVALID_PLAN" } });
    await expect(executeReconciliationPlan(cleanPlan)).resolves.toBeUndefined();

    const changedArchive = await archive(clean.projectRoot, "changed.zip", {
      [markName]: editSvg(clean.files[markName]!, "changed"),
    });
    const changedPlan = await planReconciliation({ archive: changedArchive, root: clean.projectRoot });
    await expect(executeReconciliationPlan(changedPlan)).resolves.toBeUndefined();
    expect(await readFile(join(clean.projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml"), "utf8"))
      .toContain("changed");
    const provenance = JSON.parse(await readFile(join(clean.projectRoot, ".tfsb/provenance.json"), "utf8"));
    expect(provenance.records[0].archiveDigest).toBe(computeSha256(await readFile(changedArchive)));
  });

  it("fails read-only planning when canonical bytes change after the coherent snapshot", async () => {
    const { projectRoot, source } = await imported();
    const projectPath = join(projectRoot, ".tfsb/project.toml");
    await expect(planReconciliationWithHooks(
      { archive: source, root: projectRoot },
      { afterCanonicalSnapshot: async () => writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n# concurrent\n`) },
    )).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
  });

  it("rejects apply when canonical bytes change after planning without mutating them", async () => {
    const { projectRoot, files } = await imported();
    const candidate = await archive(projectRoot, "candidate.zip", { [markName]: editSvg(files[markName]!, "incoming") });
    const plan = await planReconciliation({ archive: candidate, root: projectRoot });
    const projectPath = join(projectRoot, ".tfsb/project.toml");
    const concurrent = `${await readFile(projectPath, "utf8")}\n# concurrent\n`;
    await writeFile(projectPath, concurrent);
    await expect(executeReconciliationPlan(plan))
      .rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    expect(await readFile(projectPath, "utf8")).toBe(concurrent);
  });

  it("records canonical resolution stably and conflicts on a later archive change", async () => {
    const { projectRoot, source, files } = await imported();
    const tomlPath = join(projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml");
    await writeFile(tomlPath, (await readFile(tomlPath, "utf8")).replace("mark for light surfaces", "human canonical mark"));
    const accepted = await reconcileProject({
      archive: source, root: projectRoot, resolutions: ["theme-forge-terminal-nova-mark-on-light=canonical"], apply: true,
    });
    expect(accepted.blocked).toBe(false);
    expect((await planReconciliation({ archive: source, root: projectRoot })).records[0]?.classification)
      .toBe("UNCHANGED_ACCEPTED_DIVERGENCE");
    const later = await archive(projectRoot, "later.zip", { [markName]: editSvg(files[markName]!, "later") });
    expect((await planReconciliation({ archive: later, root: projectRoot })).records[0]?.classification).toBe("CONFLICT");
  });

  it("adds new assets without policy and retains omissions", async () => {
    const { projectRoot, files } = await imported();
    const newName = "terminal-nova-new.svg";
    const candidate = await archive(projectRoot, "new.zip", { [markName]: files[markName]!, [newName]: files[markName]! });
    const added = await reconcileProject({ archive: candidate, root: projectRoot, apply: true });
    expect(added.records.map((item) => item.classification)).toContain("NEW_ASSET");
    expect(await readFile(join(projectRoot, ".tfsb/assets/terminal-nova-new.toml"), "utf8")).toContain('id = "terminal-nova-new"');
    expect(await readFile(join(projectRoot, ".tfsb/project.toml"), "utf8")).not.toContain("terminal-nova-new");
    const omittedArchive = await archive(projectRoot, "omitted.zip", { "unsupported.bin": Buffer.from("x") });
    const omitted = await planReconciliation({ archive: omittedArchive, root: projectRoot });
    expect(omitted.records.filter((item) => item.classification === "ARCHIVE_OMISSION")).toHaveLength(2);
    expect(await access(join(projectRoot, ".tfsb/assets/terminal-nova-new.toml")).then(() => true)).toBe(true);
  });

  it("uses exact rename authority and preserves install destinations", async () => {
    const { projectRoot, files } = await imported();
    const projectPath = join(projectRoot, ".tfsb/project.toml");
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n[[install]]\nasset = "theme-forge-terminal-nova-mark-on-light"\ndestinations = ["icons/mark.svg"]\n`);
    const newName = "renamed-mark.svg";
    const candidate = await archive(projectRoot, "rename.zip", { [newName]: files[markName]! });
    const result = await reconcileProject({
      archive: candidate, root: projectRoot,
      renames: [`theme-forge-terminal-nova-mark-on-light=${newName}`], apply: true,
    });
    expect(result.records[0]?.classification).toBe("RENAMED");
    await expect(access(join(projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(projectRoot, ".tfsb/assets/renamed-mark.toml"), "utf8")).toContain('id = "renamed-mark"');
    const policy = await readFile(projectPath, "utf8");
    expect(policy).toContain('asset = "renamed-mark"');
    expect(policy).toContain('"icons/mark.svg"');
  });

  it("replaces selected companion bytes and leaves installed bytes alone", async () => {
    const projectRoot = await root();
    const companion = await production("brand-README.md");
    const svg = await production(markName);
    const source = await archive(projectRoot, "source.zip", { [markName]: svg, "README.md": companion });
    await importProject({ archive: source, root: projectRoot, schema: 1, companions: ["README.md"], recordProvenance: true });
    const projectPath = join(projectRoot, ".tfsb/project.toml");
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n[[companion]]\nfile = "README.md"\ndestinations = ["docs/vendor-README.md"]\n`);
    await mkdir(join(projectRoot, "docs"));
    const installed = join(projectRoot, "docs/vendor-README.md");
    await writeFile(installed, companion);
    const changedBytes = Buffer.concat([Buffer.from("\ufeffchanged\r\n"), companion]);
    const candidate = await archive(projectRoot, "companion.zip", { "README.md": changedBytes });
    const result = await reconcileProject({ archive: candidate, root: projectRoot, companions: ["README.md"], apply: true });
    expect(result.records[0]?.classification).toBe("COMPANION_CHANGED");
    expect(await readFile(join(projectRoot, ".tfsb/companions/README.md"))).toEqual(changedBytes);
    expect(await readFile(installed)).toEqual(Buffer.from(companion));
    expect(await readFile(projectPath, "utf8")).toContain('"docs/vendor-README.md"');
  });

  it("bootstraps matching v0.1 state without rewriting TOML and blocks mismatch", async () => {
    const matching = await imported(false);
    const before = await readFile(join(matching.projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml"));
    const applied = await reconcileProject({ archive: matching.source, root: matching.projectRoot, apply: true });
    expect(applied.records[0]?.classification).toBe("UNTRACKED_MATCH");
    expect(await readFile(join(matching.projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml"))).toEqual(before);
    await access(join(matching.projectRoot, ".tfsb/provenance.json"));

    const mismatch = await imported(false);
    const candidate = await archive(mismatch.projectRoot, "mismatch.zip", { [markName]: editSvg(mismatch.files[markName]!, "different") });
    const oldTree = await canonicalBytes(mismatch.projectRoot);
    const blocked = await reconcileProject({ archive: candidate, root: mismatch.projectRoot, apply: true });
    expect(blocked.records[0]?.classification).toBe("UNTRACKED_CONFLICT");
    expect(await canonicalBytes(mismatch.projectRoot)).toEqual(oldTree);
    await expect(access(join(mismatch.projectRoot, ".tfsb/provenance.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bootstraps matching v0.1 companion provenance without rewriting opaque bytes", async () => {
    const projectRoot = await root();
    const companion = await production("brand-README.md");
    const svg = await production(markName);
    const source = await archive(projectRoot, "source.zip", { [markName]: svg, "README.md": companion });
    await importProject({ archive: source, root: projectRoot, schema: 1, companions: ["README.md"] });
    const path = join(projectRoot, ".tfsb/companions/README.md");
    const before = await readFile(path);
    const result = await reconcileProject({ archive: source, root: projectRoot, companions: ["README.md"], apply: true });
    expect(result.records[0]?.classification).toBe("UNTRACKED_MATCH");
    expect(await readFile(path)).toEqual(before);
  });

  it("retains accepted absence as a tombstone until the archive also omits it", async () => {
    const { projectRoot, source } = await imported();
    await reconcileProject({ archive: source, root: projectRoot, removals: ["theme-forge-terminal-nova-mark-on-light"], apply: true });
    expect((await planReconciliation({ archive: source, root: projectRoot })).records[0]?.classification).toBe("UNCHANGED_ACCEPTED_ABSENCE");
    const omitted = await archive(projectRoot, "omitted.zip", { "unsupported.bin": Buffer.from("x") });
    const converged = await reconcileProject({ archive: omitted, root: projectRoot, apply: true });
    expect(converged.records[0]?.classification).toBe("CONVERGED_ABSENCE");
    await expect(access(join(projectRoot, ".tfsb/provenance.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces the complete next-project ceiling before lock or stage creation", async () => {
    const succeeds = await imported();
    const valid: Record<string, Uint8Array> = { [markName]: succeeds.files[markName]! };
    for (let index = 0; index < 127; index += 1) valid[`asset-${index.toString().padStart(3, "0")}.svg`] = succeeds.files[markName]!;
    const validArchive = await archive(succeeds.projectRoot, "128.zip", valid);
    await reconcileProject({ archive: validArchive, root: succeeds.projectRoot, apply: true });
    expect((await readdir(join(succeeds.projectRoot, ".tfsb/assets"))).filter((name) => name.endsWith(".toml"))).toHaveLength(128);

    const fails = await imported(true, [markName, "favicon-on-light.svg"]);
    const tooMany: Record<string, Uint8Array> = { [markName]: fails.files[markName]! };
    for (let index = 0; index < 127; index += 1) tooMany[`asset-${index.toString().padStart(3, "0")}.svg`] = fails.files[markName]!;
    const invalidArchive = await archive(fails.projectRoot, "129-next.zip", tooMany);
    await expect(planReconciliation({ archive: invalidArchive, root: fails.projectRoot }))
      .rejects.toMatchObject({ diagnostic: { code: "RESOURCE_LIMIT_EXCEEDED" } });
    expect((await readdir(fails.projectRoot)).filter((name) => name === ".tfsb.lock" || name.startsWith(".tfsb-stage-") || name.startsWith(".tfsb-backup-"))).toEqual([]);
  });

  it("allows one exact collision-free selector but rejects selected duplicate basenames", async () => {
    const { projectRoot, files } = await imported();
    const source = await archive(projectRoot, "shard.zip", {
      "light/mark.svg": files[markName]!,
      "dark/mark.svg": editSvg(files[markName]!, "dark"),
    });
    const one = await planReconciliation({ archive: source, root: projectRoot, selections: ["light/mark.svg", "light/mark.svg"] });
    expect(one.records.some((item) => item.classification === "NEW_ASSET")).toBe(true);
    await expect(planReconciliation({ archive: source, root: projectRoot, selections: ["light/mark.svg", "dark/mark.svg"] }))
      .rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_COLLISION" } });
  });

  it("keeps a human-edited unselected subset outside a bounded selected shard", async () => {
    const selected = "favicon-on-light.svg";
    const value = await imported(true, [markName, selected]);
    const humanPath = join(value.projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml");
    const human = (await readFile(humanPath, "utf8")).replace("mark for light surfaces", "human subset edit");
    await writeFile(humanPath, human);
    const shard = await archive(value.projectRoot, "selected-shard.zip", { [selected]: editSvg(value.files[selected]!, "selected update") });
    const result = await reconcileProject({ archive: shard, root: value.projectRoot, selections: [selected], apply: true });
    expect(result.records.map((item) => item.classification)).toEqual(["ARCHIVE_CHANGED"]);
    expect(await readFile(humanPath, "utf8")).toBe(human);
  });

  it("treats an unannounced directory move as new plus omission until exact rename authority", async () => {
    const value = await imported();
    const movedEntry = `moved/${markName}`;
    const moved = await archive(value.projectRoot, "moved.zip", { [movedEntry]: value.files[markName]! });
    const inspection = await planReconciliation({ archive: moved, root: value.projectRoot });
    expect(inspection.records.map((item) => item.classification)).toEqual(["ARCHIVE_OMISSION", "NEW_ASSET"]);
    expect(inspection.blocked).toBe(true);
    const renamed = await reconcileProject({
      archive: moved, root: value.projectRoot,
      renames: [`theme-forge-terminal-nova-mark-on-light=${movedEntry}`], apply: true,
    });
    expect(renamed.records[0]?.classification).toBe("RENAMED");
    expect((await planReconciliation({ archive: moved, root: value.projectRoot })).records[0]?.classification).toBe("UNCHANGED");
  });

  it("handles partial provenance per record and validates malformed current state first", async () => {
    const names = [markName, "favicon-on-light.svg"] as const;
    const value = await imported(true, names);
    const provenancePath = join(value.projectRoot, ".tfsb/provenance.json");
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    provenance.records = provenance.records.slice(0, 1);
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    const partial = await planReconciliation({ archive: value.source, root: value.projectRoot });
    expect(partial.records.map((item) => item.classification).sort()).toEqual(["UNCHANGED", "UNTRACKED_MATCH"]);

    await writeFile(provenancePath, "{\"kind\":\"wrong\"}\n");
    await expect(planReconciliation({ archive: value.source, root: value.projectRoot }))
      .rejects.toMatchObject({ diagnostic: { code: "PROVENANCE_UNSUPPORTED_VERSION" } });

    const malformedCanonical = await imported();
    await writeFile(join(malformedCanonical.projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml"), "schema_version = [\n");
    await expect(planReconciliation({ archive: malformedCanonical.source, root: malformedCanonical.projectRoot }))
      .rejects.toMatchObject({ diagnostic: { code: "TOML_SYNTAX" } });
  });

  it("fails closed when schema-1 archive diff sees wrong-version provenance", async () => {
    const { projectRoot, source } = await imported();
    const provenancePath = join(projectRoot, ".tfsb/provenance.json");
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    provenance.schemaVersion = 99;
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

    await expect(diffProject({ root: projectRoot, baseline: "archive", archive: source }))
      .rejects.toMatchObject({ diagnostic: { code: "PROVENANCE_UNSUPPORTED_VERSION" } });
  });

  it("revalidates archive evidence immediately before applying", async () => {
    const { projectRoot, files } = await imported();
    const candidatePath = await archive(projectRoot, "mutable.zip", { [markName]: editSvg(files[markName]!, "first") });
    const plan = await planReconciliation({ archive: candidatePath, root: projectRoot });
    const before = await canonicalBytes(projectRoot);
    await writeFile(candidatePath, zipSync({ [markName]: editSvg(files[markName]!, "second") }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    await expect(executeReconciliationPlan(plan)).rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_CHANGED_DURING_PLAN" } });
    expect(await canonicalBytes(projectRoot)).toEqual(before);
  });

  it("requires an exact direction for unexpectedly missing canonical targets", async () => {
    const restore = await imported();
    const path = join(restore.projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml");
    await rm(path);
    expect((await planReconciliation({ archive: restore.source, root: restore.projectRoot })).records[0]?.classification).toBe("CANONICAL_MISSING");
    await reconcileProject({
      archive: restore.source, root: restore.projectRoot,
      resolutions: ["theme-forge-terminal-nova-mark-on-light=archive"], apply: true,
    });
    await access(path);

    const accept = await imported();
    await rm(join(accept.projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml"));
    await reconcileProject({
      archive: accept.source, root: accept.projectRoot,
      resolutions: ["theme-forge-terminal-nova-mark-on-light=canonical"], apply: true,
    });
    expect((await planReconciliation({ archive: accept.source, root: accept.projectRoot })).records[0]?.classification)
      .toBe("UNCHANGED_ACCEPTED_ABSENCE");
  });

  it("removes an exact companion and its policy without touching destination bytes", async () => {
    const projectRoot = await root();
    const companion = await production("brand-README.md");
    const svg = await production(markName);
    const source = await archive(projectRoot, "source.zip", { [markName]: svg, "README.md": companion });
    await importProject({ archive: source, root: projectRoot, schema: 1, companions: ["README.md"], recordProvenance: true });
    const projectPath = join(projectRoot, ".tfsb/project.toml");
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n[[companion]]\nfile = "README.md"\ndestinations = ["docs/vendor-README.md"]\n`);
    await mkdir(join(projectRoot, "docs"));
    const destination = join(projectRoot, "docs/vendor-README.md");
    await writeFile(destination, companion);
    await reconcileProject({
      archive: source, root: projectRoot, companionRemovals: ["README.md"], apply: true,
    });
    await expect(access(join(projectRoot, ".tfsb/companions/README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(projectPath, "utf8")).not.toContain("[[companion]]");
    expect(await readFile(destination)).toEqual(Buffer.from(companion));
  });

  it("permits --remove and --remove-companion when selection filters are active and removed entry is absent from candidate", async () => {
    const second = "favicon-on-light.svg";
    const projectRoot = await root();
    const mark = await production(markName);
    const favicon = await production(second);
    const companion = await production("brand-README.md");
    const source = await archive(projectRoot, "initial.zip", {
      [markName]: mark,
      [second]: favicon,
      "README.md": companion,
    });
    await importProject({
      archive: source, root: projectRoot, schema: 1, companions: ["README.md"], recordProvenance: true,
    });

    // Candidate archive only contains favicon-on-light.svg; mark and README.md were dropped by upstream
    const candidate = await archive(projectRoot, "candidate.zip", {
      [second]: favicon,
    });

    // Reconcile with --select and --remove / --remove-companion
    const plan = await planReconciliation({
      archive: candidate,
      root: projectRoot,
      selections: [second],
      removals: ["theme-forge-terminal-nova-mark-on-light"],
      companionRemovals: ["README.md"],
    });
    expect(plan.records.map((r) => [r.key, r.classification])).toEqual([
      ["companion:README.md", "COMPANION_REMOVED"],
      ["favicon-on-light", "UNCHANGED"],
      ["theme-forge-terminal-nova-mark-on-light", "REMOVED"],
    ]);

    const applied = await reconcileProject({
      archive: candidate,
      root: projectRoot,
      selections: [second],
      removals: ["theme-forge-terminal-nova-mark-on-light"],
      companionRemovals: ["README.md"],
      apply: true,
    });
    expect(applied.applied).toBe(true);
    await expect(access(join(projectRoot, ".tfsb/assets/theme-forge-terminal-nova-mark-on-light.toml"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(projectRoot, ".tfsb/companions/README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await access(join(projectRoot, ".tfsb/assets/favicon-on-light.toml"));
  });
});
