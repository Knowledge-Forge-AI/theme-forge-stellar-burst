import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LoadedProject } from "./project.js";
import { TOOL_VERSION } from "./version.js";

export const BUILD_RECEIPT_FILENAME = ".tfsb-build.json";

export interface BuildReceipt {
  readonly kind: "tfsb-build-v2";
  readonly schemaVersion: 2;
  readonly toolVersion: string;
  readonly buildDirectory: string;
  readonly canonicalSources: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashes(values: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries(
    [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([name, bytes]) => [name, sha256(bytes)]),
  );
}

export function createBuildReceipt(project: LoadedProject): BuildReceipt {
  return {
    kind: "tfsb-build-v2",
    schemaVersion: 2,
    toolVersion: TOOL_VERSION,
    buildDirectory: project.project.buildDirectory,
    canonicalSources: hashes(project.canonicalFiles),
    outputs: hashes(project.outputs),
  };
}

export function serializeBuildReceipt(receipt: BuildReceipt): Uint8Array {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

export async function readBuildReceipt(buildDirectory: string): Promise<BuildReceipt | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(buildDirectory, BUILD_RECEIPT_FILENAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Partial<BuildReceipt>;
    if (
      value.kind !== "tfsb-build-v2" ||
      value.schemaVersion !== 2 ||
      typeof value.toolVersion !== "string" ||
      typeof value.buildDirectory !== "string" ||
      typeof value.canonicalSources !== "object" ||
      value.canonicalSources === null ||
      typeof value.outputs !== "object" ||
      value.outputs === null
    ) {
      return undefined;
    }
    return value as BuildReceipt;
  } catch {
    return undefined;
  }
}

export function receiptOwnsProject(receipt: BuildReceipt, buildDirectory: string): boolean {
  return (
    receipt.kind === "tfsb-build-v2" &&
    receipt.schemaVersion === 2 &&
    receipt.buildDirectory === buildDirectory
  );
}
