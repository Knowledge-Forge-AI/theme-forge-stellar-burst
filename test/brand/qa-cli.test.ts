import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import { repoPath } from "../helpers.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function capture() { let stdout = "", stderr = ""; return { io: { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } }, stdout: () => stdout, stderr: () => stderr }; }

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-qa-cli-")); roots.push(root);
  await cp(repoPath("docs/examples/v0.4/brand-system/core-minimal/.tfsb"), join(root, ".tfsb"), { recursive: true });
  await unlink(join(root, ".tfsb", "brand-package.toml"));
  const brand = join(root, ".tfsb", "brand.toml");
  await writeFile(brand, (await readFile(brand, "utf8")).replace("qa = false", "qa = true").replace("package = true", "package = false"));
  await writeFile(join(root, ".tfsb", "brand-qa.toml"), `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "semantic"
renderer = "required"
formats = ["json", "markdown", "html"]
cases = ["inventory"]
[[profiles]]
id = "optional-visual"
renderer = "optional"
formats = ["json"]
cases = ["pixels"]
[[profiles]]
id = "required-visual"
renderer = "required"
formats = ["json"]
cases = ["pixels"]
[[cases]]
id = "inventory"
kind = "inventory"
family = "core-fixture"
[[cases]]
id = "pixels"
kind = "pixel-bounds"
asset = "fixture-mark-on-light"
sizes = [[16, 16]]
backgrounds = ["transparent"]
alpha_threshold = 0
`);
  expect(await runCli(["build"], root, capture().io)).toBe(0);
  return root;
}

describe("brand QA CLI", () => {
  it("executes semantic QA and projects one JSON/Markdown/HTML result", async () => {
    const root = await project();
    const json = capture(); expect(await runCli(["qa", "--profile", "semantic", "--json"], root, json.io)).toBe(0);
    const envelope = JSON.parse(json.stdout()); expect(envelope).toMatchObject({ command: "qa", exitCode: 0, data: { schema: "tfsb.brand-qa-result", status: "pass" } });
    const markdown = capture(); expect(await runCli(["qa", "--profile", "semantic", "--report-format", "markdown"], root, markdown.io)).toBe(0); expect(markdown.stdout()).toContain("# Brand QA result");
    const html = capture(); expect(await runCli(["qa", "--profile", "semantic", "--report-format", "html"], root, html.io)).toBe(0); expect(html.stdout()).toContain("Content-Security-Policy");
  });

  it("keeps optional visual absence at zero, exposes required exit 3, and does not make check fail", async () => {
    const root = await project();
    expect(await runCli(["qa", "--profile", "optional-visual"], root, capture().io)).toBe(0);
    expect(await runCli(["qa", "--profile", "required-visual"], root, capture().io)).toBe(3);
    expect(await runCli(["check"], root, capture().io)).toBe(0);
  });

  it("rejects conflicting output flags and exposes no baseline update or visual diff CLI", async () => {
    const root = await project();
    expect(await runCli(["qa", "--profile", "semantic", "--json", "--report-format", "html"], root, capture().io)).toBe(1);
    expect(await runCli(["qa", "--profile", "semantic", "--baseline-update"], root, capture().io)).toBe(1);
    expect(await runCli(["diff", "--visual"], root, capture().io)).toBe(1);
  });
});
