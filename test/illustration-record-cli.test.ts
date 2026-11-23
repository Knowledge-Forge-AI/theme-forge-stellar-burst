import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { computeSha256 } from "../src/digests.js";
import { inspectRasterIllustrationSource } from "../src/illustration/derivative.js";
import { runIllustrationRecordCli } from "../src/illustration/record-cli.js";
import { canonicalRasterIllustrationJson, computeRasterIllustrationDigest } from "../src/illustration/v1.js";

// Synthetic one-pixel PNG fixture. It is used only to exercise local parsing,
// custody, and metadata derivation; it is not generation or visual evidence.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGM4IcLVAAAD9QFnRkI9XAAAAABJRU5ErkJggg==", "base64");
const owned: string[] = [];

afterEach(async () => {
  for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "tfsb-illustration-record-"));
  await chmod(root, 0o700);
  owned.push(root);
  return root;
}

function stream() {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    io: {
      stdout(text: string) { output.stdout += text; },
      stderr(text: string) { output.stderr += text; },
    },
  };
}

async function writeValidInputs(root: string): Promise<void> {
  await writeFile(join(root, "metadata.json"), JSON.stringify({
    illustrationId: "recorded-hero",
    revision: 4,
    operation: "import",
    characters: [{ id: "captain", revision: 1 }],
    style: { id: "stellar-burst", revision: 2 },
    provider: null,
    model: null,
    references: [],
    lineage: { parentDigest: null },
    exportRecipes: [],
  }));
  await writeFile(join(root, "source.png"), PNG);
}

describe("illustration record CLI", () => {
  it("derives source facts, canonical digest, and private exclusive output", async () => {
    const root = await fixture();
    await writeValidInputs(root);
    const captured = stream();

    expect(await runIllustrationRecordCli([
      "record", "--request", "metadata.json", "--source", "source.png", "--mime", "image/png",
      "--output", "record.json", "--json",
    ], root, captured.io)).toBe(0);

    const result = JSON.parse(captured.output.stdout) as {
      readonly state: string;
      readonly data: {
        readonly record: Record<string, unknown>;
        readonly recordDigest: string;
        readonly source: {
          readonly sha256: string;
          readonly byteLength: number;
          readonly mime: string;
          readonly dimensions: { readonly width: number; readonly height: number };
          readonly alpha: string;
          readonly verification: string;
        };
        readonly metadataOnly: boolean;
        readonly providerAttested: boolean;
      };
    };
    const record = result.data.record as {
      readonly digest: string;
      readonly source: {
        readonly sha256: string;
        readonly byteLength: number;
        readonly mime: string;
        readonly dimensions: { readonly width: number; readonly height: number };
        readonly alpha: string;
      };
    };
    const inspection = inspectRasterIllustrationSource(PNG, "image/png");
    const expectedSha = computeSha256(PNG);
    expect(result.state).toBe("completed");
    expect(result.data.metadataOnly).toBe(true);
    expect(result.data.providerAttested).toBe(false);
    expect(result.data.recordDigest).toBe(record.digest);
    expect(record.digest).toBe(computeRasterIllustrationDigest(result.data.record));
    expect(record.source).toEqual({
      sha256: expectedSha,
      mime: "image/png",
      byteLength: PNG.byteLength,
      dimensions: { width: inspection.width, height: inspection.height },
      alpha: inspection.alpha === "has-alpha" ? "straight" : inspection.alpha,
    });
    expect(result.data.source).toEqual({
      ...record.source,
      verification: "png-pixels-decoded",
    });
    expect(captured.output.stdout).not.toContain(root);
    expect(captured.output.stdout).not.toContain("metadata.json");
    expect(await readFile(join(root, "record.json"), "utf8")).toBe(canonicalRasterIllustrationJson(result.data.record));
    expect((await lstat(join(root, "record.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects duplicate metadata keys and caller-supplied source/schema fields", async () => {
    const root = await fixture();
    await writeFile(join(root, "source.png"), PNG);
    const duplicate = stream();
    await writeFile(join(root, "duplicate.json"), '{"illustrationId":"one","illustrationId":"two","revision":1,"operation":"import","characters":[],"style":{"id":"fixture","revision":1}}');
    expect(await runIllustrationRecordCli([
      "record", "--request", "duplicate.json", "--source", "source.png", "--mime", "image/png", "--output", "duplicate-out.json", "--json",
    ], root, duplicate.io)).toBe(1);
    expect(JSON.parse(duplicate.output.stdout).data.failureCode).toBe("REQUEST_INPUT_INVALID");
    await expect(lstat(join(root, "duplicate-out.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const bom = stream();
    await writeFile(join(root, "bom.json"), `\uFEFF${JSON.stringify({ illustrationId: "recorded-hero", revision: 1, operation: "import", characters: [], style: { id: "fixture", revision: 1 } })}`);
    expect(await runIllustrationRecordCli([
      "record", "--request", "bom.json", "--source", "source.png", "--mime", "image/png", "--output", "bom-out.json", "--json",
    ], root, bom.io)).toBe(1);
    expect(JSON.parse(bom.output.stdout).data.failureCode).toBe("REQUEST_INPUT_INVALID");

    const override = stream();
    await writeFile(join(root, "override.json"), JSON.stringify({
      illustrationId: "recorded-hero", revision: 1, operation: "import", characters: [], style: { id: "fixture", revision: 1 },
      source: { sha256: "sha256:bad" }, schema: "caller-controlled",
    }));
    expect(await runIllustrationRecordCli([
      "record", "--request", "override.json", "--source", "source.png", "--mime", "image/png", "--output", "override-out.json", "--json",
    ], root, override.io)).toBe(1);
    expect(JSON.parse(override.output.stdout).data.failureCode).toBe("REQUEST_INPUT_INVALID");
    await expect(lstat(join(root, "override-out.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const invalidToken = stream();
    await writeFile(join(root, "invalid-token.json"), JSON.stringify({
      illustrationId: "recorded-hero", revision: 1, operation: "import", characters: [], style: { id: "fixture", revision: 1 },
      provider: "sk-secret-token",
    }));
    expect(await runIllustrationRecordCli([
      "record", "--request", "invalid-token.json", "--source", "source.png", "--mime", "image/png", "--output", "invalid-token-out.json", "--json",
    ], root, invalidToken.io)).toBe(1);
    expect(JSON.parse(invalidToken.output.stdout).data.failureCode).toBe("REQUEST_INPUT_INVALID");
    expect(invalidToken.output.stdout + invalidToken.output.stderr).not.toContain("sk-secret-token");
  });

  it("rejects malformed sources and never clobbers an existing output", async () => {
    const root = await fixture();
    await writeValidInputs(root);
    const malformed = stream();
    await writeFile(join(root, "malformed.png"), Buffer.from("not-a-png"));
    expect(await runIllustrationRecordCli([
      "record", "--request", "metadata.json", "--source", "malformed.png", "--mime", "image/png", "--output", "malformed-out.json", "--json",
    ], root, malformed.io)).toBe(1);
    expect(JSON.parse(malformed.output.stdout).data.failureCode).toBe("SOURCE_INPUT_INVALID");
    await expect(lstat(join(root, "malformed-out.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const outputPath = join(root, "record.json");
    const sentinel = Buffer.from("operator-owned-output\n");
    await writeFile(outputPath, sentinel, { mode: 0o600 });
    const collision = stream();
    expect(await runIllustrationRecordCli([
      "record", "--request", "metadata.json", "--source", "source.png", "--mime", "image/png", "--output", "record.json", "--json",
    ], root, collision.io)).toBe(1);
    expect(JSON.parse(collision.output.stdout).data.failureCode).toBe("OUTPUT_TARGET_EXISTS");
    expect(await readFile(outputPath)).toEqual(sentinel);

    const symlinkTarget = join(root, "symlink-target.json");
    await writeFile(symlinkTarget, sentinel, { mode: 0o600 });
    await symlink(symlinkTarget, join(root, "symlink-output.json"));
    const symlinkResult = stream();
    expect(await runIllustrationRecordCli([
      "record", "--request", "metadata.json", "--source", "source.png", "--mime", "image/png", "--output", "symlink-output.json", "--json",
    ], root, symlinkResult.io)).toBe(1);
    expect(JSON.parse(symlinkResult.output.stdout).data.failureCode).toBe("OUTPUT_TARGET_EXISTS");
    expect(await readFile(symlinkTarget)).toEqual(sentinel);
  });

  it("suppresses private paths and values in failure output", async () => {
    const root = await fixture();
    const captured = stream();
    const privateRequest = join(root, "secret-token-request.json");
    expect(await runIllustrationRecordCli([
      "record", "--request", privateRequest, "--source", "source.png", "--mime", "image/png", "--output", "new.json", "--json",
    ], root, captured.io)).toBe(1);
    expect(captured.output.stdout + captured.output.stderr).not.toContain(privateRequest);
    expect(captured.output.stdout + captured.output.stderr).not.toContain("secret-token");
    expect(captured.output.stdout + captured.output.stderr).not.toContain(root);

    const traversal = stream();
    expect(await runIllustrationRecordCli([
      "record", "--request", "../secret-token-request.json", "--source", "source.png", "--mime", "image/png", "--output", "traversal.json", "--json",
    ], root, traversal.io)).toBe(1);
    expect(JSON.parse(traversal.output.stdout).data.failureCode).toBe("REQUEST_INPUT_INVALID");
    expect(traversal.output.stdout + traversal.output.stderr).not.toContain("secret-token");
  });
});
