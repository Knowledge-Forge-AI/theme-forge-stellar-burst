import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildProject,
  checkWorkspace,
  listWorkspace,
  parseWorkspaceListCursor,
  parseWorkspacePreviewMarker,
  previewWorkspace,
  type WorkspacePreviewMetrics,
  type WorkspaceStreamMetrics,
} from "../src/index.js";
import { runCli } from "../src/cli.js";
import { paginateWorkspacePreviewAssets } from "../src/workspace-preview.js";
import { makeTempDir } from "./helpers.js";

const roots: string[] = [];
function temp(): string { const value = makeTempDir("tfsb-workspace-aggregate-"); roots.push(value); return value; }
function asset(id: string): string {
  return `schema_version = 1\nid = ${JSON.stringify(id)}\nfilename = ${JSON.stringify(`${id}.svg`)}\n\n[canvas]\nview_box = "0 0 10 10"\n\n[accessibility]\ntitle = "Synthetic"\ntitle_id = "title"\ndescription = "Synthetic."\ndescription_id = "description"\n\n[[elements]]\ntype = "path"\nd = "M 0 0 H 10 V 10 Z"\n`;
}
function child(root: string, path: string, ids: readonly string[], name = "Synthetic child"): string {
  const childRoot = join(root, path);
  mkdirSync(join(childRoot, ".tfsb", "assets"), { recursive: true });
  writeFileSync(join(childRoot, ".tfsb", "project.toml"), `schema_version = 1\nname = ${JSON.stringify(name)}\n\n[build]\ndirectory = "dist"\n`);
  for (const id of ids) writeFileSync(join(childRoot, ".tfsb", "assets", `${id}.toml`), asset(id));
  return childRoot;
}
function manifest(root: string, projects: readonly { id: string; path: string; collections?: readonly string[] }[], name = "Workspace"): string {
  const text = `schema_version = 1\nid = "workspace"\nname = ${JSON.stringify(name)}\n${projects.map((project) => `\n[[project]]\nid = ${JSON.stringify(project.id)}\npath = ${JSON.stringify(project.path)}\ncollections = [${(project.collections ?? []).map((value) => JSON.stringify(value)).join(", ")}]\n`).join("")}`;
  const path = join(root, ".tfsb-workspace.toml");
  writeFileSync(path, text);
  return path;
}
function snapshot(root: string, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) for (const [key, value] of snapshot(root, path)) result.set(key, value);
    else result.set(path, readFileSync(join(root, path), "utf8"));
  }
  return result;
}
function io() { let out = ""; let err = ""; return { io: { stdout: (value: string) => { out += value; }, stderr: (value: string) => { err += value; } }, stdout: () => out, stderr: () => err }; }
function cursorCode(value: string): string | undefined { try { parseWorkspaceListCursor(value); return undefined; } catch (error) { return (error as { diagnostic?: { code?: string } }).diagnostic?.code; } }
function cursorBytes(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("workspace list aggregation", () => {
  it("streams deterministic pages with a closed child-bound cursor", async () => {
    const root = temp();
    child(root, "projects/alpha", Array.from({ length: 65 }, (_, index) => `asset-${String(index).padStart(3, "0")}`));
    const file = manifest(root, [{ id: "alpha", path: "projects/alpha", collections: ["icons"] }]);
    const metrics: WorkspaceStreamMetrics = { loadedChildren: 0, maxLoadedChildren: 0 };
    const first = await listWorkspace({ workspaceFile: file, metrics });
    expect(first.page.recordCount).toBe(64);
    expect(first.workspace.recordCount).toBe(65);
    expect(first.page.nextCursor).not.toBeNull();
    expect(first.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.page.nextCursor).not.toContain("=");
    expect(first.page.nextCursor).toBe("eyJzY2hlbWFWZXJzaW9uIjoxLCJvcGVyYXRpb24iOiJsaXN0Iiwid29ya3NwYWNlRGlnZXN0Ijoic2hhMjU2OjM5MTY0N2ZhN2E3Yzc2NGI0ZDZjNzk0Y2RkOGY2ZmM5MDU4ZTU1NjJlNTkwMjI1MGEzZjJkODcwZmM0MzJkM2QiLCJwYWdlU2l6ZSI6NjQsImxhc3RLZXkiOnsicHJvamVjdElkIjoiYWxwaGEiLCJraW5kIjoiYXNzZXQiLCJpZCI6ImFzc2V0LTA2MyJ9LCJjaGVja3N1bSI6InNoYTI1Njo1NjA3YzkyNGNjYzJlNTc3NDM5ZDY3YzY1YTkzZjExNzUwNDY1ZDlmZGJkNmI1MTI1MzM3NTEzMDcyYmI5MDM4In0");
    const decoded = parseWorkspaceListCursor(first.page.nextCursor!);
    expect(Object.keys(decoded)).toEqual(["schemaVersion", "operation", "workspaceDigest", "pageSize", "lastKey", "checksum"]);
    expect(cursorCode("***")).toBe("CURSOR_INVALID");
    expect(cursorCode(Buffer.from("{", "utf8").toString("base64url"))).toBe("CURSOR_INVALID");
    expect(cursorCode(cursorBytes({ ...decoded, unknown: true }))).toBe("CURSOR_INVALID");
    expect(cursorCode(cursorBytes({ ...decoded, schemaVersion: 2 }))).toBe("CURSOR_INVALID");
    expect(cursorCode(cursorBytes({ ...decoded, operation: "check" }))).toBe("CURSOR_INVALID");
    expect(cursorCode(cursorBytes({ ...decoded, lastKey: { ...decoded.lastKey, kind: "project" } }))).toBe("CURSOR_INVALID");
    expect(cursorCode(cursorBytes({ ...decoded, checksum: "sha256:nope" }))).toBe("CURSOR_INVALID");
    const corrupted = { ...decoded, checksum: "sha256:" + (decoded.checksum[7] === "0" ? "1" : "0") + decoded.checksum.slice(8) };
    await expect(listWorkspace({ workspaceFile: file, cursor: cursorBytes(corrupted) })).rejects.toMatchObject({ diagnostic: { code: "CURSOR_INVALID" } });
    const second = await listWorkspace({ workspaceFile: file, cursor: first.page.nextCursor! });
    expect(second.page.records.map((item) => item.id)).toEqual(["asset-064"]);
    expect(second.page.nextCursor).toBeNull();
    expect(metrics.maxLoadedChildren).toBe(1);
    expect(metrics.loadedChildren).toBe(0);
  });

  it("handles empty and exact boundaries and rejects page/cursor drift", async () => {
    const root = temp();
    const empty = manifest(root, []);
    expect((await listWorkspace({ workspaceFile: empty })).page).toMatchObject({ recordCount: 0, nextCursor: null });
    expect(await checkWorkspace({ workspaceFile: empty })).toMatchObject({ status: "ok", projects: { total: 0, checked: 0, clean: 0, drifted: 0, failed: 0 } });
    expect(await previewWorkspace({ workspaceFile: empty, output: "empty-preview" })).toMatchObject({ projectCount: 0, assetCount: 0, pageCount: 0 });
    await expect(listWorkspace({ workspaceFile: empty, pageSize: 0 })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PAGE_SIZE_INVALID" } });
    await expect(listWorkspace({ workspaceFile: empty, pageSize: 129 })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PAGE_SIZE_INVALID" } });

    child(root, "projects/alpha", ["a", "b"]);
    const file = manifest(root, [{ id: "alpha", path: "projects/alpha" }]);
    const first = await listWorkspace({ workspaceFile: file, pageSize: 1 });
    writeFileSync(join(root, "projects/alpha/.tfsb/project.toml"), 'schema_version = 1\nname = "Changed"\n\n[build]\ndirectory = "changed-dist"\n');
    await expect(listWorkspace({ workspaceFile: file, pageSize: 1, cursor: first.page.nextCursor! })).rejects.toMatchObject({ diagnostic: { code: "CURSOR_STALE" } });
    await expect(listWorkspace({ workspaceFile: file, pageSize: 2, cursor: first.page.nextCursor! })).rejects.toMatchObject({ diagnostic: { code: "CURSOR_INVALID" } });
    writeFileSync(join(root, "workspace.toml"), readFileSync(file));
    await expect(listWorkspace({ workspaceFile: join(root, "workspace.toml") })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_INVALID_FILENAME" } });
  });

  it("qualifies 1,024 streamed children and a multi-thousand record view", { timeout: 60_000 }, async () => {
    const childScaleRoot = temp();
    const childProjects = Array.from({ length: 1024 }, (_, index) => ({ id: `p-${index}`, path: `projects/${index}` }));
    for (const project of childProjects) child(childScaleRoot, project.path, []);
    const childScaleFile = manifest(childScaleRoot, childProjects);
    const childMetrics: WorkspaceStreamMetrics = { loadedChildren: 0, maxLoadedChildren: 0 };
    const childScale = await listWorkspace({ workspaceFile: childScaleFile, metrics: childMetrics });
    expect(childScale.workspace).toMatchObject({ projectCount: 1024, recordCount: 0 });
    expect(childMetrics).toEqual({ loadedChildren: 0, maxLoadedChildren: 1 });
    const childChecks = await checkWorkspace({ workspaceFile: childScaleFile, metrics: childMetrics });
    expect(childChecks.projects).toEqual({ total: 1024, checked: 1024, clean: 0, drifted: 1024, failed: 0 });
    expect(childChecks.children).toHaveLength(1024);
    expect(childMetrics.maxLoadedChildren).toBe(1);

    const recordScaleRoot = temp();
    const recordProjects = Array.from({ length: 16 }, (_, index) => ({ id: `p-${String(index).padStart(2, "0")}`, path: `projects/${index}` }));
    for (const project of recordProjects) child(recordScaleRoot, project.path, Array.from({ length: 128 }, (_, index) => `asset-${String(index).padStart(3, "0")}-${project.id}`));
    const recordScaleFile = manifest(recordScaleRoot, recordProjects);
    const recordMetrics: WorkspaceStreamMetrics = { loadedChildren: 0, maxLoadedChildren: 0 };
    const first = await listWorkspace({ workspaceFile: recordScaleFile, pageSize: 128, metrics: recordMetrics });
    const second = await listWorkspace({ workspaceFile: recordScaleFile, pageSize: 128, cursor: first.page.nextCursor!, metrics: recordMetrics });
    expect(first.workspace.recordCount).toBe(2048);
    expect(first.page.records).toHaveLength(128);
    expect(second.page.records).toHaveLength(128);
    expect(first.page.records.at(-1)?.projectId).toBe("p-00");
    expect(second.page.records.at(0)?.projectId).toBe("p-01");
    expect(recordMetrics.maxLoadedChildren).toBe(1);
  });
});

describe("workspace check aggregation", () => {
  it("reports exact clean, drift, failed, and collision arithmetic", async () => {
    const root = temp();
    const cleanRoot = child(root, "projects/clean", ["clean"]);
    child(root, "projects/drift", ["drift"]);
    mkdirSync(join(root, "projects/missing"), { recursive: true });
    await buildProject(cleanRoot, false);
    const file = manifest(root, [
      { id: "clean", path: "projects/clean" },
      { id: "drift", path: "projects/drift" },
      { id: "missing", path: "projects/missing" },
    ]);
    const result = await checkWorkspace({ workspaceFile: file });
    expect(result.status).toBe("error");
    expect(result.projects).toEqual({ total: 3, checked: 2, clean: 1, drifted: 1, failed: 1 });
    expect(result.drift.buildMissing).toBe(1);
    expect(result.children.map((item) => item.status)).toEqual(["clean", "drift", "error"]);

    const collisionRoot = temp();
    child(collisionRoot, "a", ["same"]); child(collisionRoot, "b", ["same"]);
    const collisionFile = manifest(collisionRoot, [{ id: "a", path: "a" }, { id: "b", path: "b" }]);
    const collision = await checkWorkspace({ workspaceFile: collisionFile });
    expect(collision.status).toBe("error");
    expect(collision.diagnostics.map((item) => item.code)).toContain("WORKSPACE_ASSET_ID_COLLISION");
  });
});

describe("workspace scriptless preview", () => {
  it("keeps presentation pages at 128 records through the future-limit seam", () => {
    expect([...paginateWorkspacePreviewAssets(Array.from({ length: 129 }, (_, index) => index))].map((page) => page.length)).toEqual([128, 1]);
  });
  it("publishes and safely replaces a deterministic escaped owned tree", async () => {
    const root = temp();
    child(root, "projects/alpha", ["a", "b"], "<Alpha & friends>");
    const file = manifest(root, [{ id: "alpha", path: "projects/alpha", collections: ["icons"] }], "<Workspace & friends>");
    const metrics: WorkspacePreviewMetrics = { loadedChildren: 0, maxLoadedChildren: 0, pageAssets: 0, maxPageAssets: 0 };
    const first = await previewWorkspace({ workspaceFile: file, metrics });
    const output = join(root, first.outputDirectory);
    const before = snapshot(output);
    const marker = parseWorkspacePreviewMarker(before.get(".tfsb-preview.json")!);
    expect(marker.kind).toBe("tfsb-workspace-preview-v1");
    expect(marker.fileCount).toBe(before.size - 1);
    expect(before.get("index.html")).toContain("&lt;Workspace &amp; friends&gt;");
    expect(before.get("projects/alpha/page-0001.html")).toContain("&lt;Alpha &amp; friends&gt;");
    const html = [...before].filter(([path]) => path.endsWith(".html")).map(([, value]) => value).join("\n");
    expect(html).not.toMatch(/<script|\son[a-z]+\s*=|https?:\/\//i);
    expect(metrics.maxLoadedChildren).toBe(1);
    expect(metrics.maxPageAssets).toBe(2);
    const second = await previewWorkspace({ workspaceFile: file, metrics });
    expect(second.replaced).toBe(true);
    expect(snapshot(output)).toEqual(before);
  });

  it("rejects collisions, unowned output, and corrupted stages without publication", async () => {
    const root = temp();
    child(root, "a", ["same"]); child(root, "b", ["same"]);
    const file = manifest(root, [{ id: "a", path: "a" }, { id: "b", path: "b" }]);
    await expect(previewWorkspace({ workspaceFile: file })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_ASSET_ID_COLLISION" } });
    expect(() => readFileSync(join(root, ".tfsb-workspace-preview/index.html"))).toThrow();

    const safeRoot = temp(); child(safeRoot, "Projects/Alpha", ["a"]); const safeFile = manifest(safeRoot, [{ id: "child", path: "Projects/Alpha" }]);
    await expect(previewWorkspace({ workspaceFile: safeFile, output: "projects/alpha/preview" })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PREVIEW_UNSAFE_OUTPUT" } });
    await expect(previewWorkspace({ workspaceFile: safeFile, output: "Projects/Alpha" })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PREVIEW_UNSAFE_OUTPUT" } });
    await expect(previewWorkspace({ workspaceFile: safeFile, output: ".tfsb-workspace.toml" })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PREVIEW_UNSAFE_OUTPUT" } });
    await expect(previewWorkspace({ workspaceFile: safeFile, output: ".TFSB-WORKSPACE.TOML" })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PREVIEW_UNSAFE_OUTPUT" } });
    await expect(previewWorkspace({ workspaceFile: safeFile, output: "." })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PREVIEW_UNSAFE_OUTPUT" } });
    mkdirSync(join(safeRoot, "unowned")); writeFileSync(join(safeRoot, "unowned/file"), "mine");
    await expect(previewWorkspace({ workspaceFile: safeFile, output: "unowned" })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PREVIEW_UNOWNED" } });
    await expect(previewWorkspace({ workspaceFile: safeFile }, { afterStage: (stage) => { writeFileSync(join(stage, "extra"), "x"); } })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PREVIEW_UNOWNED" } });
    expect(() => readFileSync(join(safeRoot, ".tfsb-workspace-preview/index.html"))).toThrow();
  });

  it("preserves ownership across target, rollback, and post-promotion cleanup races", async () => {
    const root = temp(); child(root, "child", ["a"]); const file = manifest(root, [{ id: "child", path: "child" }]);
    const first = await previewWorkspace({ workspaceFile: file });
    const output = join(root, first.outputDirectory);
    const original = snapshot(output);
    await expect(previewWorkspace({ workspaceFile: file }, { afterBackup: () => { throw new Error("pre-commit stop"); } })).rejects.toThrow("pre-commit stop");
    expect(snapshot(output)).toEqual(original);
    await expect(previewWorkspace({ workspaceFile: file }, { beforeBackupCleanup: () => { throw new Error("cleanup stop"); } })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PREVIEW_BACKUP_CLEANUP_FAILED" } });
    expect(snapshot(output)).toEqual(original);

    const raceRoot = temp(); child(raceRoot, "child", ["a"]); const raceFile = manifest(raceRoot, [{ id: "child", path: "child" }]);
    const raceOutput = join(raceRoot, ".tfsb-workspace-preview");
    await expect(previewWorkspace({ workspaceFile: raceFile }, { afterStage: () => { mkdirSync(raceOutput); writeFileSync(join(raceOutput, "mine"), "preserve"); } })).rejects.toMatchObject({ diagnostic: { code: "WORKSPACE_PREVIEW_UNOWNED" } });
    expect(readFileSync(join(raceOutput, "mine"), "utf8")).toBe("preserve");
  });
});

describe("workspace CLI authority", () => {
  it("routes only list/check/preview and rejects contradictory or mutating forms", async () => {
    const root = temp(); const file = manifest(root, []);
    for (const command of ["import", "reconcile", "migrate", "fmt", "build", "install", "bundle", "shard", "analyze", "diff"]) {
      const capture = io();
      expect(await runCli([command, "--workspace", file], root, capture.io)).toBe(1);
      expect(capture.stderr()).toContain("--workspace is not supported");
    }
    const conflict = io();
    expect(await runCli(["list", "--workspace", file, "--root", root], root, conflict.io)).toBe(1);
    expect(conflict.stderr()).toContain("mutually exclusive");
    const listed = io();
    expect(await runCli(["list", "--workspace", file, "--json"], root, listed.io)).toBe(0);
    expect(JSON.parse(listed.stdout())).toMatchObject({ command: "list", status: "ok", data: { workspace: { recordCount: 0 }, page: { nextCursor: null } } });
    expect(listed.stderr()).toBe("");
  });
});
