import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLE_MANIFEST_FILENAME,
  readManifestArchive,
} from "../../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0, roots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("generic manifest v2 file disposition", () => {
  it.each(["brand/brand.toml", "derived/target.receipt.json"])("fails closed when ordinary manifest import encounters file record %s", async (path) => {
    const tmp = await mkdtemp(join(tmpdir(), "tfsb-gen-disp-"));
    roots.push(tmp);
    const archivePath = join(tmp, "generic-v2-with-file.zip");

    const manifestJson = {
      kind: "tfsb-bundle-manifest",
      schemaVersion: 2,
      generator: {
        name: "theme-forge-stellar-burst",
        version: "0.3.0",
      },
      projectName: "generic-v2-proj",
      files: [
        {
          type: "file",
          path,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      ],
    };

    const zipBytes = zipSync({
      [BUNDLE_MANIFEST_FILENAME]: [Buffer.from(JSON.stringify(manifestJson), "utf8"), { level: 0 }],
      [path]: [Buffer.from(""), { level: 0 }],
    });

    await writeFile(archivePath, zipBytes);

    await expect(readManifestArchive(archivePath)).rejects.toThrow(
      /MANIFEST_UNSUPPORTED_RECORD|brand domain files require --brand-package/,
    );
  });
});
