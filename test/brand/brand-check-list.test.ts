import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkProject, listProject } from "../../src/index.js";
import { runCli } from "../../src/cli.js";
import { readRepoFile } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0, roots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

function runSubprocessCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const cliPath = join(process.cwd(), "dist/cli.js");
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString?.() ?? "",
      stderr: error.stderr?.toString?.() ?? "",
      status: typeof error.status === "number" ? error.status : 1,
    };
  }
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function setupProject(branded = false, packageEnabled = false, tokensEnabled = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-check-list-"));
  roots.push(root);

  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });

  const projectToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml");
  const assetDark = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml");
  const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");

  await writeFile(join(root, ".tfsb", "project.toml"), projectToml);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-dark.toml"), assetDark);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);

  if (branded) {
    let brandToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    if (!packageEnabled) {
      brandToml = brandToml.replace("package = true", "package = false");
    } else {
      const pkgToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand-package.toml");
      await writeFile(join(root, ".tfsb", "brand-package.toml"), pkgToml);
    }
    if (tokensEnabled) {
      brandToml = brandToml.replace("tokens = false", "tokens = true");
      await writeFile(join(root, ".tfsb", "brand-tokens.toml"), 'schema = "tfsb.brand-tokens"\nschema_version = 1\n');
    }
    await writeFile(join(root, ".tfsb", "brand.toml"), brandToml);
  }

  // Write build outputs so check is clean
  await runCli(["build"], root, capture().io);

  return root;
}

describe("brand-aware list and check", () => {
  it("preserves exact unbranded behavior for list and check", async () => {
    const unbrandedRoot = await setupProject(false);

    // API list
    const unbrandedList = await listProject(unbrandedRoot);
    expect(unbrandedList.brand).toBeUndefined();
    expect(unbrandedList.assets.length).toBe(2);

    // API check
    const unbrandedCheck = await checkProject(unbrandedRoot);
    expect(unbrandedCheck.brand).toBeUndefined();
    expect(unbrandedCheck.drift).toBe(false);

    // CLI list human
    const listHuman = capture();
    expect(await runCli(["list"], unbrandedRoot, listHuman.io)).toBe(0);
    expect(listHuman.stdout()).not.toContain("brand:");
    expect(listHuman.stdout()).toContain("fixture-mark-on-dark");

    // CLI list JSON
    const listJson = capture();
    expect(await runCli(["list", "--json"], unbrandedRoot, listJson.io)).toBe(0);
    const parsedListJson = JSON.parse(listJson.stdout());
    expect(parsedListJson.status).toBe("ok");
    expect(parsedListJson.data.brand).toBeUndefined();

    // CLI check human
    const checkHuman = capture();
    expect(await runCli(["check"], unbrandedRoot, checkHuman.io)).toBe(0);
    expect(checkHuman.stdout()).toBe("canonical: valid\nsource: clean\nbuild: clean\ninstall: clean\n");

    // CLI check JSON
    const checkJson = capture();
    expect(await runCli(["check", "--json"], unbrandedRoot, checkJson.io)).toBe(0);
    const parsedCheckJson = JSON.parse(checkJson.stdout());
    expect(parsedCheckJson.status).toBe("ok");
    expect(parsedCheckJson.data.brand).toBeUndefined();

    // Subprocess unbranded list & check
    if (existsSync(join(process.cwd(), "dist/cli.js"))) {
      const subList = runSubprocessCli(["list"], unbrandedRoot);
      expect(subList.status).toBe(0);
      expect(subList.stdout).not.toContain("brand:");
      expect(subList.stdout).toContain("fixture-mark-on-dark");

      const subListJson = runSubprocessCli(["list", "--json"], unbrandedRoot);
      expect(subListJson.status).toBe(0);
      const parsedSubList = JSON.parse(subListJson.stdout);
      expect(parsedSubList.status).toBe("ok");
      expect(parsedSubList.data.brand).toBeUndefined();

      const subCheck = runSubprocessCli(["check"], unbrandedRoot);
      expect(subCheck.status).toBe(0);
      expect(subCheck.stdout).toBe("canonical: valid\nsource: clean\nbuild: clean\ninstall: clean\n");

      const subCheckJson = runSubprocessCli(["check", "--json"], unbrandedRoot);
      expect(subCheckJson.status).toBe(0);
      const parsedSubCheck = JSON.parse(subCheckJson.stdout);
      expect(parsedSubCheck.status).toBe("ok");
      expect(parsedSubCheck.data.brand).toBeUndefined();
    }
  });

  it("extends list with bounded brand section on branded projects", async () => {
    const brandedRoot = await setupProject(true, false);

    // API list
    const inventory = await listProject(brandedRoot);
    expect(inventory.brand).toBeDefined();
    expect(inventory.brand?.schemaVersion).toBe(1);
    expect(inventory.brand?.brandDigest).toBe("sha256:d69829ae3f45ef2d79f11b9a0b0097fbd61a9342aa5c53a607de762eccf21ee2");
    expect(inventory.brand?.brandSystemDigest).toBe("sha256:0d399a54375f952fc75a31e1ca59c99df4699dd3b665b99e30998470203a5980");
    expect(inventory.brand?.families.length).toBe(1);
    expect(inventory.brand?.variants.length).toBe(2);
    expect(inventory.brand?.bindings.length).toBe(2);
    expect(inventory.brand?.completeness.satisfied).toBe(true);

    // CLI list human
    const listHuman = capture();
    expect(await runCli(["list"], brandedRoot, listHuman.io)).toBe(0);
    expect(listHuman.stdout()).toContain("brand: schema 1; digest sha256:d69829ae3f45ef2d79f11b9a0b0097fbd61a9342aa5c53a607de762eccf21ee2");
    expect(listHuman.stdout()).toContain("family: core-fixture (Core Fixture Brand)");
    expect(listHuman.stdout()).toContain("variant: core-fixture:standard-light");
    expect(listHuman.stdout()).toContain("binding: core-fixture:mark:standard-light -> fixture-mark-on-light (source)");
    expect(listHuman.stdout()).toContain("completeness: satisfied");

    // CLI list JSON
    const listJson = capture();
    expect(await runCli(["list", "--json"], brandedRoot, listJson.io)).toBe(0);
    const parsed = JSON.parse(listJson.stdout());
    expect(parsed.data.brand).toBeDefined();
    expect(parsed.data.brand.brandDigest).toBe("sha256:d69829ae3f45ef2d79f11b9a0b0097fbd61a9342aa5c53a607de762eccf21ee2");

    // Subprocess branded list
    if (existsSync(join(process.cwd(), "dist/cli.js"))) {
      const subList = runSubprocessCli(["list"], brandedRoot);
      expect(subList.status).toBe(0);
      expect(subList.stdout).toContain("brand: schema 1; digest sha256:d69829ae3f45ef2d79f11b9a0b0097fbd61a9342aa5c53a607de762eccf21ee2");

      const subListJson = runSubprocessCli(["list", "--json"], brandedRoot);
      expect(subListJson.status).toBe(0);
      const parsedSub = JSON.parse(subListJson.stdout);
      expect(parsedSub.data.brand).toBeDefined();
      expect(parsedSub.data.brand.brandDigest).toBe("sha256:d69829ae3f45ef2d79f11b9a0b0097fbd61a9342aa5c53a607de762eccf21ee2");
    }
  });

  it("extends check with bounded brand section and handles available package domain", async () => {
    // Package enabled -> available in B2
    const brandedRoot = await setupProject(true, true, false);

    // API check
    const checkResult = await checkProject(brandedRoot);
    expect(checkResult.brand).toBeDefined();
    expect(checkResult.brand?.valid).toBe(true);
    expect(checkResult.brand?.completenessSatisfied).toBe(true);
    expect(checkResult.brand?.brandDigest).toBe("sha256:40554e6807109966b1561707aeb32c11cf112b7807e477ccafa1cece28fd86a8");
    // In B2 with package available, system digest is computed
    expect(checkResult.brand?.brandSystemDigest).toBe("sha256:4e10ef25161f37bdd137bcf85fcf1b842b4e0a6512f863d7f2fbba0d8a7e9c4d");
    expect(checkResult.drift).toBe(false);

    const pkgDomain = checkResult.brand?.domains.find((d) => d.domain === "package");
    expect(pkgDomain?.state).toBe("available");
    expect(pkgDomain?.present).toBe(true);

    // CLI check human
    const checkHuman = capture();
    expect(await runCli(["check"], brandedRoot, checkHuman.io)).toBe(0);
    expect(checkHuman.stdout()).toContain("brand: valid");
    expect(checkHuman.stdout()).toContain("brand digest: sha256:40554e6807109966b1561707aeb32c11cf112b7807e477ccafa1cece28fd86a8");
    expect(checkHuman.stdout()).toContain("brand system digest: sha256:4e10ef25161f37bdd137bcf85fcf1b842b4e0a6512f863d7f2fbba0d8a7e9c4d");
    expect(checkHuman.stdout()).toContain("brand completeness: satisfied");
    expect(checkHuman.stdout()).toContain("brand domain: package (available)");
    expect(checkHuman.stdout()).toContain("brand file: .tfsb/brand-package.toml (present)");

    // CLI check JSON
    const checkJson = capture();
    expect(await runCli(["check", "--json"], brandedRoot, checkJson.io)).toBe(0);
    const parsed = JSON.parse(checkJson.stdout());
    expect(parsed.status).toBe("ok");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.data.brand.domains.find((d: any) => d.domain === "package").state).toBe("available");
  });

  it("handles available tokens domain and declared-unavailable domain", async () => {
    const brandedRoot = await setupProject(true, true, true);

    const checkResult = await checkProject(brandedRoot);
    expect(checkResult.brand).toBeDefined();
    expect(checkResult.brand?.brandSystemDigest).toBeDefined();

    const tokensDomain = checkResult.brand?.domains.find((d) => d.domain === "tokens");
    expect(tokensDomain?.state).toBe("available");
    expect(tokensDomain?.present).toBe(true);

    const checkHuman = capture();
    expect(await runCli(["check"], brandedRoot, checkHuman.io)).toBe(0);
    expect(checkHuman.stdout()).toContain("brand domain: tokens (available)");
    expect(checkHuman.stdout()).toContain("brand file: .tfsb/brand-tokens.toml (present)");

    // QA is an available domain once its exact schema is present.
    const brandTomlPath = join(brandedRoot, ".tfsb", "brand.toml");
    const brandTomlContent = (await readFile(brandTomlPath, "utf8")).replace("qa = false", "qa = true");
    await writeFile(brandTomlPath, brandTomlContent);
    await writeFile(join(brandedRoot, ".tfsb", "brand-qa.toml"), `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "check"
renderer = "optional"
formats = ["json"]
cases = ["inventory"]
[[cases]]
id = "inventory"
kind = "inventory"
family = "core-fixture"
`);

    const checkUnavailable = await checkProject(brandedRoot);
    expect(checkUnavailable.brand).toBeDefined();
    expect(checkUnavailable.brand?.brandSystemDigest).toBeDefined();
    const qaDomain = checkUnavailable.brand?.domains.find((d) => d.domain === "qa");
    expect(qaDomain?.state).toBe("available");
    expect(qaDomain?.present).toBe(true);
    expect(checkUnavailable.brand?.qa?.semanticPass).toBe(1);
  });

  it("handles malformed brand.toml with sanitized error and exit code 1", async () => {
    const root = await setupProject(true, false);
    await writeFile(join(root, ".tfsb", "brand.toml"), "invalid = toml [[ broken\n");

    const cli = capture();
    expect(await runCli(["check"], root, cli.io)).toBe(1);
    expect(cli.stderr()).toContain("SCHEMA_INVALID_SYNTAX");
    expect(cli.stderr()).not.toContain(tmpdir());

    const jsonCli = capture();
    expect(await runCli(["check", "--json"], root, jsonCli.io)).toBe(1);
    const parsed = JSON.parse(jsonCli.stdout());
    expect(parsed.status).toBe("error");
    expect(parsed.exitCode).toBe(1);
    expect(parsed.diagnostics[0].code).toBe("SCHEMA_INVALID_SYNTAX");

    // Subprocess error
    if (existsSync(join(process.cwd(), "dist/cli.js"))) {
      const subError = runSubprocessCli(["check"], root);
      expect(subError.status).toBe(1);
      expect(subError.stderr).toContain("SCHEMA_INVALID_SYNTAX");
      expect(subError.stderr).not.toContain(tmpdir());

      const subErrorJson = runSubprocessCli(["check", "--json"], root);
      expect(subErrorJson.status).toBe(1);
      const parsedErr = JSON.parse(subErrorJson.stdout);
      expect(parsedErr.status).toBe("error");
      expect(parsedErr.exitCode).toBe(1);
      expect(parsedErr.diagnostics[0].code).toBe("SCHEMA_INVALID_SYNTAX");
    }
  });
});
