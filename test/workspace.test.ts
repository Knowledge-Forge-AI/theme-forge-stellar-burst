import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKSPACE_MAX_BYTES,
  WORKSPACE_MAX_PROJECTS,
  computeWorkspaceDigest,
  discoverWorkspace,
  parseWorkspace,
  serializeWorkspace,
} from "../src/index.js";
import { firstCode, makeTempDir, readRepoFile, unwrap } from "./helpers.js";

const roots: string[] = [];

function root(): string {
  const value = makeTempDir("tfsb-workspace-");
  roots.push(value);
  return value;
}

function asset(id: string): string {
  return `schema_version = 1
id = "${id}"
filename = "${id}.svg"

[canvas]
view_box = "0 0 10 10"

[accessibility]
title = "Synthetic"
title_id = "title"
description = "Synthetic."
description_id = "description"

[[elements]]
type = "path"
d = "M 0 0 H 10 V 10 Z"
`;
}

function child(workspaceRoot: string, path: string, assetId?: string): void {
  const canonical = join(workspaceRoot, path, ".tfsb");
  mkdirSync(join(canonical, "assets"), { recursive: true });
  writeFileSync(join(canonical, "project.toml"), 'schema_version = 1\nname = "Synthetic child"\n\n[build]\ndirectory = "dist"\n');
  if (assetId !== undefined) writeFileSync(join(canonical, "assets", `${assetId}.toml`), asset(assetId));
}

function manifest(projects = ""): string {
  return `schema_version = 1\nid = "workspace"\nname = "Workspace"\n${projects}`;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("workspace schema 1", () => {
  it("canonically converges the TFSB41 example and digest", () => {
    const parsed = unwrap(parseWorkspace(readRepoFile("docs/examples/v0.4/workspace.toml")));
    const canonical = serializeWorkspace(parsed);
    expect(serializeWorkspace(unwrap(parseWorkspace(canonical)))).toBe(canonical);
    expect(computeWorkspaceDigest(unwrap(parseWorkspace(canonical)))).toBe(computeWorkspaceDigest(parsed));
    expect(computeWorkspaceDigest(parsed)).toBe("sha256:bae31ef13cefbf7aec84187d5e8584eb10de5ca0489403a502bb25852f850609");
    const formatted = `# formatting is not semantic\nname = "Design asset workspace"\nid = "design-assets"\nschema_version = 1\n\n[[project]]\ncollections = ["terminal-nova-brand"]\npath = "projects/terminal-nova-brand"\nid = "terminal-nova-brand"\n\n[[project]]\ncollections = ["tabler-outline"]\npath = "projects/tabler-outline-actions"\nid = "tabler-outline-actions"\n\n[[project]]\ncollections = ["tabler-filled"]\npath = "projects/tabler-filled-actions"\nid = "tabler-filled-actions"\n`;
    expect(computeWorkspaceDigest(unwrap(parseWorkspace(formatted)))).toBe(computeWorkspaceDigest(parsed));
  });

  it("enforces exact manifest and child-count limits", () => {
    const base = manifest();
    const exact = `${base}#${"x".repeat(WORKSPACE_MAX_BYTES - Buffer.byteLength(base) - 2)}\n`;
    expect(Buffer.byteLength(exact)).toBe(WORKSPACE_MAX_BYTES);
    expect(parseWorkspace(exact).ok).toBe(true);
    expect(firstCode(parseWorkspace(`${exact}x`))).toBe("WORKSPACE_SIZE_LIMIT");

    const records = Array.from({ length: WORKSPACE_MAX_PROJECTS }, (_, index) => `\n[[project]]\nid = "p-${index}"\npath = "p/${index}"\ncollections = []\n`).join("");
    expect(unwrap(parseWorkspace(manifest(records))).projects).toHaveLength(WORKSPACE_MAX_PROJECTS);
    expect(firstCode(parseWorkspace(manifest(`${records}\n[[project]]\nid = "over"\npath = "over"\ncollections = []\n`)))).toBe("WORKSPACE_PROJECT_LIMIT");
  });

  it("rejects unknown keys, invalid collection IDs, portable path aliases, and overlap", () => {
    expect(firstCode(parseWorkspace(`${manifest()}unknown = true\n`))).toBe("WORKSPACE_UNKNOWN_FIELD");
    expect(firstCode(parseWorkspace(manifest('\n[[project]]\nid = "one"\npath = "one"\ncollections = ["Not-Kebab"]\n')))).toBe("WORKSPACE_INVALID_ID");
    expect(firstCode(parseWorkspace(manifest('\n[[project]]\nid = "one"\npath = "one"\ncollections = []\n\n[[project]]\nid = "one"\npath = "two"\ncollections = []\n')))).toBe("WORKSPACE_DUPLICATE_PROJECT");
    expect(firstCode(parseWorkspace(manifest('\n[[project]]\nid = "one"\npath = "Projects/A"\ncollections = []\n\n[[project]]\nid = "two"\npath = "projects/a"\ncollections = []\n')))).toBe("WORKSPACE_DUPLICATE_PATH");
    expect(firstCode(parseWorkspace(manifest('\n[[project]]\nid = "one"\npath = "projects/a"\ncollections = []\n\n[[project]]\nid = "two"\npath = "projects/a/nested"\ncollections = []\n')))).toBe("WORKSPACE_CHILD_OVERLAP");
    expect(parseWorkspace(manifest('\n[[project]]\nid = "one"\npath = "projects/ leading"\ncollections = []\n')).ok).toBe(false);
  });

  it("loads children independently and retains qualified duplicate-ID diagnostics", async () => {
    const workspaceRoot = root();
    child(workspaceRoot, "projects/one", "shared");
    child(workspaceRoot, "projects/two", "shared");
    writeFileSync(join(workspaceRoot, ".tfsb-workspace.toml"), manifest('\n[[project]]\nid = "one"\npath = "projects/one"\ncollections = ["icons"]\n\n[[project]]\nid = "two"\npath = "projects/two"\ncollections = ["icons"]\n'));
    const result = unwrap(await discoverWorkspace(workspaceRoot));
    expect([...result.projects.keys()]).toEqual(["one", "two"]);
    expect(result.projects.get("one")?.qualifiedAssetIds).toEqual(["one/shared"]);
    expect(result.projects.get("two")?.qualifiedAssetIds).toEqual(["two/shared"]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["WORKSPACE_ASSET_ID_COLLISION"]);
    expect(result).not.toHaveProperty("lock");
    expect(result).not.toHaveProperty("transaction");
    expect(JSON.stringify({ diagnostics: result.diagnostics, projects: [...result.projects.values()] })).not.toContain(workspaceRoot);
  });

  it("tolerates a child load failure with a diagnostic while returning successfully loaded children", async () => {
    const workspaceRoot = root();
    child(workspaceRoot, "projects/valid", "asset-a");
    // projects/broken has no .tfsb/project.toml
    mkdirSync(join(workspaceRoot, "projects", "broken"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".tfsb-workspace.toml"), manifest('\n[[project]]\nid = "valid"\npath = "projects/valid"\ncollections = []\n\n[[project]]\nid = "broken"\npath = "projects/broken"\ncollections = []\n'));
    const result = unwrap(await discoverWorkspace(workspaceRoot));
    expect([...result.projects.keys()]).toEqual(["valid"]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["WORKSPACE_PROJECT_MISSING"]);
    expect(JSON.stringify(result)).not.toContain(workspaceRoot);
  });

  it("rejects a symlinked child component without exposing the absolute root", async () => {
    const workspaceRoot = root();
    const outside = root();
    child(outside, "child");
    mkdirSync(join(workspaceRoot, "projects"));
    symlinkSync(join(outside, "child"), join(workspaceRoot, "projects", "linked"));
    writeFileSync(join(workspaceRoot, ".tfsb-workspace.toml"), manifest('\n[[project]]\nid = "linked"\npath = "projects/linked"\ncollections = []\n'));
    const result = unwrap(await discoverWorkspace(workspaceRoot));
    expect([...result.projects.keys()]).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["WORKSPACE_UNSAFE_CHILD"]);
    expect(JSON.stringify(result)).not.toContain(workspaceRoot);
  });

  it("rejects a symlinked workspace root before reading its manifest", async () => {
    const realRoot = root();
    const parent = root();
    writeFileSync(join(realRoot, ".tfsb-workspace.toml"), manifest());
    const linkedRoot = join(parent, "linked");
    symlinkSync(realRoot, linkedRoot);
    const result = await discoverWorkspace(linkedRoot);
    expect(firstCode(result)).toBe("WORKSPACE_UNSAFE_ROOT");
    expect(JSON.stringify(result)).not.toContain(realRoot);
    expect(JSON.stringify(result)).not.toContain(parent);
  });
});
