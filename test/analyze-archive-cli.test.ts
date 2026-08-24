import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { analyze, inspectAnalyzeInput } from "../src/index.js";
import { runCli } from "../src/cli.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const valid = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" role="img" aria-labelledby="t d"><title id="t">T</title><desc id="d">D</desc><path d="M0 0L1 1"/></svg>';
async function archive(files: Record<string, Uint8Array>, level: 0 | 9 = 0): Promise<{ root: string; path: string }> { const root = await realpath(await mkdtemp(join(tmpdir(), "tfsb-analyze-zip-"))); roots.push(root); const path = join(root, "input.bin"); await writeFile(path, zipSync(files, { level, mtime: new Date("1980-01-02T00:00:00Z") })); return { root, path }; }
function capture() { let stdout = ""; let stderr = ""; return { io: { stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; } }, stdout: () => stdout, stderr: () => stderr }; }

describe("analyze ZIP adapter", () => {
  it("identifies ZIP by safe signature rather than extension and processes SVG entries in UTF-8 order", async () => {
    const value = await archive({ "z.svg": strToU8(valid), "a.svg": strToU8(valid), "notes.txt": strToU8("ignored") });
    const result = await analyze({ input: value.path });
    expect(result.data.input.kind).toBe("archive"); expect(result.data.totals.files).toBe(3);
    expect(result.files.map((file) => file.path)).toEqual(["a.svg", "z.svg"]);
  });

  it.each(["../bad.svg", "/bad.svg", "a\\bad.svg"])("maps unsafe ZIP path %s to the public archive failure", async (name) => {
    const value = await archive({ [name]: strToU8(valid) });
    await expect(analyze({ input: value.path })).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_ARCHIVE_INVALID" } });
  });

  it("rejects portable duplicate names through the existing ZIP safety layer", async () => {
    const value = await archive({ "A.svg": strToU8(valid), "a.svg": strToU8(valid) });
    await expect(analyze({ input: value.path })).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_ARCHIVE_INVALID" } });
  });

  it("maps excessive compression to the exact scan-abort code", async () => {
    const value = await archive({ "large.svg": new Uint8Array(64 * 1024) }, 9);
    await expect(analyze({ input: value.path })).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_ARCHIVE_COMPRESSION_RATIO_EXCEEDED" } });
  });

  it("detects archive identity change after planning", async () => {
    const value = await archive({ "a.svg": strToU8(valid) }); const plan = await inspectAnalyzeInput(value.path);
    await appendFile(value.path, Buffer.from([0]));
    await expect(import("../src/analyze.js").then(({ executeCompleteAnalysis }) => executeCompleteAnalysis(plan))).rejects.toMatchObject({ diagnostic: { code: "ANALYZE_SOURCE_CHANGED" } });
  });
});

describe("analyze CLI", () => {
  it("emits one JSON envelope, empty stderr, and target-profile status parity", async () => {
    const value = await archive({ "unsafe.svg": strToU8(valid.replace("<path", "<script/><path")) }); const output = capture();
    const exit = await runCli(["analyze", value.path, "--json"], value.root, output.io);
    expect(exit).toBe(1); expect(output.stderr()).toBe("");
    const envelope = JSON.parse(output.stdout()); expect(envelope).toMatchObject({ command: "analyze", status: "error", exitCode: 1, data: { scanCompleted: true } });
    expect(output.stdout().endsWith("\n")).toBe(true);
  });

  it("supports details beside JSON and produces no other writes", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "tfsb-analyze-cli-"))); roots.push(directory); await writeFile(join(directory, "a.svg"), valid);
    const out = await realpath(await mkdtemp(join(tmpdir(), "tfsb-analyze-cli-out-"))); roots.push(out); const target = join(out, "details.ndjson"); const output = capture();
    expect(await runCli(["analyze", directory, "--details", target, "--json"], out, output.io)).toBe(0);
    expect(JSON.parse(output.stdout()).status).toBe("ok"); expect(output.stderr()).toBe(""); expect((await readFile(target, "utf8")).split("\n")[0]).toContain('"recordType":"header"');
  });

  it.each([
    [[], "requires exactly one"], [["a", "b"], "requires exactly one"], [["a", "--json", "--json"], "cannot be repeated"], [["a", "--details", "x", "--details", "y"], "cannot be repeated"], [["a", "--root", "."], "Invalid command arguments"],
  ])("rejects malformed analyze arguments %#", async (parts, expected) => {
    const output = capture(); expect(await runCli(["analyze", ...(parts as string[])], process.cwd(), output.io)).toBe(1); expect(`${output.stdout()}${output.stderr()}`).toContain(expected);
  });

  it("human output names both profiles, the status basis, exact omission counts, and the permission disclaimer", async () => {
    const value = await archive({ "a.svg": strToU8(valid.replace("<path", "<symbol/><path")) }); const output = capture();
    expect(await runCli(["analyze", value.path], value.root, output.io)).toBe(2);
    expect(output.stdout()).toContain("tfsb-svg-schema-1"); expect(output.stdout()).toContain("tfsb-svg-common-v0.3");
    expect(output.stdout()).toContain("status is based only"); expect(output.stdout()).toContain("0 omitted");
    expect(output.stdout()).toContain("not import, legal, trademark, or redistribution permission"); expect(output.stderr()).toBe("");
  });

  it.each([
    ["invalid input path", "nonexistent-dir-or-archive.zip", "ANALYZE_INPUT_INVALID"],
    ["excessive compression", "compression-ratio-exceeded.zip", "ANALYZE_ARCHIVE_COMPRESSION_RATIO_EXCEEDED"],
  ])("emits incomplete_scan JSON envelope with status error, exitCode 1, and data null for %s", async (label, file, expectedCode) => {
    let targetPath = file;
    let cwd = process.cwd();
    if (label === "excessive compression") {
      const val = await archive({ "huge.svg": new Uint8Array(64 * 1024) }, 9);
      targetPath = val.path;
      cwd = val.root;
    }
    const output = capture();
    const exit = await runCli(["analyze", targetPath, "--json"], cwd, output.io);
    expect(exit).toBe(1);
    expect(output.stderr()).toBe("");
    const envelope = JSON.parse(output.stdout());
    expect(envelope).toMatchObject({
      command: "analyze",
      status: "error",
      exitCode: 1,
      data: null,
    });
    expect(envelope.diagnostics[0]?.code).toBe(expectedCode);
  });
});

