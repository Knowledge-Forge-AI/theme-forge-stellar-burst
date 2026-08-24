import { appendFile, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync, type Zippable } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { ARCHIVE_LIMITS, readArchive, readSvgArchive } from "../src/archive.js";
import { mutationAggregateBytesExceedsLimit, mutationSvgCountExceedsLimit } from "../src/archive-limits.js";
import { computeSha256 } from "../src/digests.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function archive(files: Zippable, level: 0 | 9 = 0): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-archive-"));
  roots.push(root);
  const path = join(root, "fixture.zip");
  await writeFile(path, zipSync(files, { level, mtime: new Date("1980-01-02T00:00:00Z") }));
  return path;
}

function encrypted(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice();
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  for (let offset = 0; offset + 10 <= result.length; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) view.setUint16(offset + 6, view.getUint16(offset + 6, true) | 1, true);
    if (signature === 0x02014b50) view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 1, true);
  }
  return result;
}

async function sparseArchiveAtRawLimit(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-archive-limit-"));
  roots.push(root);
  const path = join(root, "maximum.zip");
  const raw = zipSync({ "a.svg": strToU8("<svg></svg>") }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") });
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const eocd = raw.length - 22;
  const oldCentralOffset = view.getUint32(eocd + 16, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const newCentralOffset = ARCHIVE_LIMITS.archiveFileBytes - centralSize - 22;
  const ending = raw.slice(oldCentralOffset);
  new DataView(ending.buffer, ending.byteOffset, ending.byteLength)
    .setUint32(centralSize + 16, newCentralOffset, true);
  const handle = await open(path, "w+");
  try {
    await handle.write(raw.subarray(0, oldCentralOffset), 0, oldCentralOffset, 0);
    await handle.write(ending, 0, ending.length, newCentralOffset);
    await handle.truncate(ARCHIVE_LIMITS.archiveFileBytes);
  } finally {
    await handle.close();
  }
  return path;
}

describe("bounded ZIP archive inspection", () => {
  it("reads only selected SVG entries and ignores unrelated regular files", async () => {
    const path = await archive({
      "icons/a.svg": strToU8("<svg>A</svg>"),
      "icons/b.svg": strToU8("<svg>B</svg>"),
      "empty/": new Uint8Array(),
      "notes.txt": strToU8("not canonical"),
    });
    const selected = await readSvgArchive(path, ["icons/b.svg"]);
    expect(selected.map((entry) => entry.entryName)).toEqual(["icons/b.svg"]);
    expect(new TextDecoder().decode(selected[0]?.bytes)).toBe("<svg>B</svg>");
  });

  it.each(["../evil.svg", "/evil.svg", "a\\evil.svg", "a/./evil.svg"])(
    "rejects unsafe entry name %s",
    async (name) => {
      const path = await archive({ [name]: strToU8("x") });
      await expect(readSvgArchive(path)).rejects.toMatchObject({
        diagnostic: { code: "ARCHIVE_UNSAFE_PATH" },
      });
    },
  );

  it("rejects portable normalized duplicates", async () => {
    const path = await archive({ "A.svg": strToU8("a"), "a.svg": strToU8("b") });
    await expect(readSvgArchive(path)).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_COLLISION" },
    });

    const nfcPath = await archive({
      "caf\u00e9.svg": strToU8("a"),
      "cafe\u0301.svg": strToU8("b"),
    });
    await expect(readSvgArchive(nfcPath)).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_COLLISION" },
    });
  });

  it("rejects Unix symlink metadata", async () => {
    const path = await archive({
      "link.svg": [strToU8("target"), { os: 3, attrs: 0o120777 << 16 }],
    });
    await expect(readSvgArchive(path)).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_UNSAFE_TYPE" },
    });
  });

  it("rejects encrypted flags before attempting inflation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-archive-"));
    roots.push(root);
    const path = join(root, "encrypted.zip");
    await writeFile(path, encrypted(zipSync({ "a.svg": strToU8("x") }, { level: 0 })));
    await expect(readSvgArchive(path)).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_ENCRYPTED" },
    });
  });

  it("rejects missing selections and excessive expansion ratios", async () => {
    const normal = await archive({ "a.svg": strToU8("x") });
    await expect(readSvgArchive(normal, ["missing.svg"])).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_SELECTION_MISSING" },
    });

    const compressed = await archive({ "large.svg": new Uint8Array(32_768) }, 9);
    await expect(readSvgArchive(compressed)).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" },
    });
  });

  it("enforces entry-count, selection-count, per-entry, and aggregate limits", async () => {
    const manyEntries: Zippable = {};
    for (let index = 0; index < 1_025; index += 1) {
      manyEntries[`notes/${index}.txt`] = new Uint8Array();
    }
    await expect(readSvgArchive(await archive(manyEntries))).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" },
    });

    const manySvg: Zippable = {};
    for (let index = 0; index < 129; index += 1) manySvg[`${index}.svg`] = strToU8("x");
    await expect(readSvgArchive(await archive(manySvg))).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" },
    });

    await expect(
      readSvgArchive(await archive({ "large.svg": new Uint8Array(8 * 1024 * 1024 + 1) })),
    ).rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" } });

    const chunk = new Uint8Array(7 * 1024 * 1024);
    const aggregate: Zippable = {};
    for (let index = 0; index < 5; index += 1) aggregate[`${index}.svg`] = chunk;
    await expect(readSvgArchive(await archive(aggregate))).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" },
    });
  });

  it("accepts exact 128-entry and 32 MiB selected boundaries and rejects one over", async () => {
    const exactCount: Zippable = {};
    for (let index = 0; index < 128; index += 1) exactCount[`${index}.svg`] = strToU8("x");
    expect(await readSvgArchive(await archive(exactCount))).toHaveLength(128);
    exactCount["128.svg"] = strToU8("x");
    await expect(readSvgArchive(await archive(exactCount))).rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" } });

    expect(mutationSvgCountExceedsLimit(128)).toBe(false);
    expect(mutationSvgCountExceedsLimit(129)).toBe(true);
    expect(mutationAggregateBytesExceedsLimit(32 * 1024 * 1024)).toBe(false);
    expect(mutationAggregateBytesExceedsLimit(32 * 1024 * 1024 + 1)).toBe(true);
  });

  it("rejects an oversized sparse file before structure validation or hashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-archive-oversized-"));
    roots.push(root);
    const path = join(root, "oversized.zip");
    const handle = await open(path, "w+");
    await handle.truncate(ARCHIVE_LIMITS.archiveFileBytes + 1);
    await handle.close();
    let structureReached = false;
    let hashReached = false;
    await expect(readArchive(path, [], [], {
      hooks: {
        afterStructure: () => { structureReached = true; },
        beforeHash: () => { hashReached = true; },
      },
    })).rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" } });
    expect(structureReached).toBe(false);
    expect(hashReached).toBe(false);
  });

  it("rejects malformed ZIP structure without a whole-archive hash pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-archive-malformed-"));
    roots.push(root);
    const path = join(root, "malformed.zip");
    await writeFile(path, Buffer.alloc(512 * 1024, 0x61));
    let hashReached = false;
    await expect(readArchive(path, [], [], { hooks: { beforeHash: () => { hashReached = true; } } }))
      .rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_INVALID_ZIP" } });
    expect(hashReached).toBe(false);
  });

  it("accepts a valid sparse ZIP at the exact fixed raw-file ceiling", async () => {
    const path = await sparseArchiveAtRawLimit();
    const result = await readArchive(path);
    expect(result.svgs.map((entry) => entry.entryName)).toEqual(["a.svg"]);
    expect(result.archiveDigest).toBe(computeSha256(await readFile(path)));
  });

  it.each(["afterStructure", "onHashChunk", "beforeSelectedEntryInspection"] as const)(
    "fails closed when archive identity changes at the %s phase",
    async (phase) => {
      const path = await archive({
        "a.svg": strToU8("<svg></svg>"),
        "padding.bin": new Uint8Array(192 * 1024),
      });
      let mutated = false;
      const mutate = async () => {
        if (mutated) return;
        mutated = true;
        await appendFile(path, "x");
      };
      await expect(readArchive(path, [], [], { hooks: { [phase]: mutate } }))
        .rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_CHANGED_DURING_PLAN" } });
    },
  );

  it("rejects declared entry compressedSize exceeding limits or file extents", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-archive-"));
    roots.push(root);

    // 1. compressedSize exceeding selectedEntryBytes (e.g. 0xFFFFFFFE)
    const rawZip = zipSync({ "a.svg": strToU8("<svg>a</svg>") }, { level: 0 });
    const evilHuge = rawZip.slice();
    const viewHuge = new DataView(evilHuge.buffer, evilHuge.byteOffset, evilHuge.byteLength);
    for (let offset = 0; offset + 46 <= evilHuge.length; offset += 1) {
      if (viewHuge.getUint32(offset, true) === 0x02014b50) {
        viewHuge.setUint32(offset + 20, 0xfffffffe, true);
      }
    }
    const pathHuge = join(root, "evil-huge.zip");
    await writeFile(pathHuge, evilHuge);
    await expect(readSvgArchive(pathHuge)).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" },
    });

    // 2. compressedSize within entry limits but exceeding actual file extent
    const evilExtent = rawZip.slice();
    const viewExtent = new DataView(evilExtent.buffer, evilExtent.byteOffset, evilExtent.byteLength);
    for (let offset = 0; offset + 46 <= evilExtent.length; offset += 1) {
      if (viewExtent.getUint32(offset, true) === 0x02014b50) {
        viewExtent.setUint32(offset + 20, 5000, true);
      }
    }
    const pathExtent = join(root, "evil-extent.zip");
    await writeFile(pathExtent, evilExtent);
    await expect(readSvgArchive(pathExtent)).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_INVALID_ZIP" },
    });
  });

  it("enforces companion allowlist and rejects unsupported companion file extensions", async () => {
    const path = await archive({
      "icon.svg": strToU8("<svg></svg>"),
      "README.md": strToU8("# README"),
      "LICENSE": strToU8("MIT"),
      "notes.txt": strToU8("notes"),
      "guide.markdown": strToU8("# Guide"),
      "NOTICE": strToU8("Notice text"),
      "tools/generate.py": strToU8("print('script')"),
      "scripts/install.sh": strToU8("#!/bin/sh"),
    });

    const accepted = await readArchive(path, [], [
      "README.md",
      "LICENSE",
      "notes.txt",
      "guide.markdown",
      "NOTICE",
    ]);
    expect(accepted.companions).toHaveLength(5);

    await expect(readArchive(path, [], ["tools/generate.py"])).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_COMPANION_UNSUPPORTED" },
    });
    await expect(readArchive(path, [], ["scripts/install.sh"])).rejects.toMatchObject({
      diagnostic: { code: "ARCHIVE_COMPANION_UNSUPPORTED" },
    });
  });
});
