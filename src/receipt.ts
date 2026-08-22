import { createHash } from "node:crypto";
import { join } from "node:path";

import { fail, type DiagnosticContext } from "./diagnostics.js";
import { optionalLstat, readRegularFileSnapshot } from "./filesystem.js";
import type { LoadedProject } from "./project.js";
import { compareUtf8 } from "./provenance.js";
import { TOOL_VERSION } from "./version.js";

export const BUILD_RECEIPT_FILENAME = ".tfsb-build.json";
export const BUILD_RECEIPT_MAX_BYTES = 512 * 1024;
const RAW_SHA256 = /^[0-9a-f]{64}$/;

export interface BuildReceiptV2 {
  readonly kind: "tfsb-build-v2";
  readonly schemaVersion: 2;
  readonly toolVersion: string;
  readonly buildDirectory: string;
  readonly canonicalSources: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
}

export interface BuildReceiptInstallPolicyV3 {
  readonly assetId: string;
  readonly destinations: readonly string[];
}

export interface BuildReceiptCompanionPolicyV3 {
  readonly file: string;
  readonly destinations: readonly string[];
}

export interface BuildReceiptProjectPolicyV3 {
  readonly buildDirectory: string;
  readonly installs: readonly BuildReceiptInstallPolicyV3[];
  readonly companions: readonly BuildReceiptCompanionPolicyV3[];
}

export interface BuildReceiptV3 {
  readonly kind: "tfsb-build-v3";
  readonly schemaVersion: 3;
  readonly toolVersion: string;
  readonly buildDirectory: string;
  readonly canonicalSources: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly projectPolicy: BuildReceiptProjectPolicyV3;
}

export type BuildReceipt = BuildReceiptV2 | BuildReceiptV3;
export type BuildReceiptReadResult =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "v2"; readonly receipt: BuildReceiptV2 }
  | { readonly status: "v3"; readonly receipt: BuildReceiptV3 };

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isProjectRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const normalized = value.normalize("NFC");
  return normalized === value && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function hashMap(value: unknown, keyKind: "source" | "output"): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const key of Object.keys(value).sort(compareUtf8)) {
    const digest = value[key];
    const validKey = keyKind === "source"
      ? (key === ".tfsb/project.toml" || /^\.tfsb\/(?:assets\/[a-z0-9]+(?:-[a-z0-9]+)*\.toml|companions\/[^/]+|provenance\.json)$/.test(key))
      : /^[A-Za-z0-9][A-Za-z0-9._-]*\.svg$/.test(key);
    if (!validKey || key.includes("\0") || typeof digest !== "string" || !RAW_SHA256.test(digest)) return undefined;
    result[key] = digest;
  }
  return result;
}

function policy(value: unknown): BuildReceiptProjectPolicyV3 | undefined {
  if (!isRecord(value) || !exactKeys(value, ["buildDirectory", "installs", "companions"]) || !isProjectRelativePath(value.buildDirectory) || !Array.isArray(value.installs) || !Array.isArray(value.companions)) return undefined;
  const installs: BuildReceiptInstallPolicyV3[] = [];
  const companions: BuildReceiptCompanionPolicyV3[] = [];
  const installKeys = new Set<string>();
  const companionKeys = new Set<string>();
  for (const item of value.installs) {
    if (!isRecord(item) || !exactKeys(item, ["assetId", "destinations"]) || typeof item.assetId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.assetId) || !Array.isArray(item.destinations) || item.destinations.some((destination) => !isProjectRelativePath(destination)) || new Set(item.destinations).size !== item.destinations.length || installKeys.has(item.assetId)) return undefined;
    installKeys.add(item.assetId);
    installs.push({ assetId: item.assetId, destinations: [...item.destinations].sort(compareUtf8) });
  }
  for (const item of value.companions) {
    if (!isRecord(item) || !exactKeys(item, ["file", "destinations"]) || !isProjectRelativePath(item.file) || item.file.includes("/") || !Array.isArray(item.destinations) || item.destinations.some((destination) => !isProjectRelativePath(destination)) || new Set(item.destinations).size !== item.destinations.length || companionKeys.has(item.file)) return undefined;
    companionKeys.add(item.file);
    companions.push({ file: item.file, destinations: [...item.destinations].sort(compareUtf8) });
  }
  installs.sort((left, right) => compareUtf8(left.assetId, right.assetId));
  companions.sort((left, right) => compareUtf8(left.file, right.file));
  return { buildDirectory: value.buildDirectory, installs, companions };
}

function hashes(values: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries([...values.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([name, bytes]) => [name, sha256(bytes)]));
}

export function createBuildReceipt(project: LoadedProject): BuildReceiptV3 {
  const installs = project.project.installs.map((item) => ({ assetId: item.asset, destinations: [...item.destinations].sort(compareUtf8) })).sort((left, right) => compareUtf8(left.assetId, right.assetId));
  const companions = project.project.companions.map((item) => ({ file: item.file, destinations: [...item.destinations].sort(compareUtf8) })).sort((left, right) => compareUtf8(left.file, right.file));
  return {
    kind: "tfsb-build-v3", schemaVersion: 3, toolVersion: TOOL_VERSION,
    buildDirectory: project.project.buildDirectory,
    canonicalSources: hashes(project.canonicalFiles), outputs: hashes(project.outputs),
    projectPolicy: { buildDirectory: project.project.buildDirectory, installs, companions },
  };
}

export function serializeBuildReceipt(receipt: BuildReceipt): Uint8Array {
  const normalized = normalizeBuildReceipt(receipt);
  if (normalized === undefined) {
    fail(
      { operation: "serialize", domain: "filesystem" },
      "BUILD_RECEIPT_INVALID",
      "Build receipt value is not a valid v2 or v3 receipt.",
    );
  }
  return Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

function normalizeBuildReceipt(value: unknown): BuildReceipt | undefined {
  if (!isRecord(value)) return undefined;
  const common = ["kind", "schemaVersion", "toolVersion", "buildDirectory", "canonicalSources", "outputs"];
  const isV3 = value.kind === "tfsb-build-v3" && value.schemaVersion === 3;
  if (!exactKeys(value, isV3 ? [...common, "projectPolicy"] : common) || typeof value.toolVersion !== "string" || value.toolVersion === "" || value.toolVersion.includes("\0") || !isProjectRelativePath(value.buildDirectory)) return undefined;
  const canonicalSources = hashMap(value.canonicalSources, "source");
  const outputs = hashMap(value.outputs, "output");
  if (canonicalSources === undefined || outputs === undefined) return undefined;
  if (value.kind === "tfsb-build-v2" && value.schemaVersion === 2) return { kind: value.kind, schemaVersion: 2, toolVersion: value.toolVersion, buildDirectory: value.buildDirectory, canonicalSources, outputs };
  if (isV3) {
    const projectPolicy = policy(value.projectPolicy);
    if (projectPolicy === undefined || projectPolicy.buildDirectory !== value.buildDirectory) return undefined;
    return { kind: "tfsb-build-v3", schemaVersion: 3, toolVersion: value.toolVersion, buildDirectory: value.buildDirectory, canonicalSources, outputs, projectPolicy };
  }
  return undefined;
}

export function parseBuildReceipt(text: string): BuildReceiptReadResult {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { status: "invalid" }; }
  const normalized = normalizeBuildReceipt(value);
  if (normalized === undefined) return { status: "invalid" };
  return normalized.schemaVersion === 2
    ? { status: "v2", receipt: normalized }
    : { status: "v3", receipt: normalized };
}

export async function readBuildReceipt(
  buildDirectory: string,
  operation: DiagnosticContext["operation"] = "build",
): Promise<BuildReceiptReadResult> {
  const path = join(buildDirectory, BUILD_RECEIPT_FILENAME);
  if (await optionalLstat(path) === undefined) return { status: "absent" };
  const { bytes } = await readRegularFileSnapshot(
    path,
    { operation, domain: "filesystem" },
    "BUILD_RECEIPT_UNSAFE",
    "Build receipt must be one bounded non-symlink regular file.",
    BUILD_RECEIPT_MAX_BYTES,
  );
  return parseBuildReceipt(Buffer.from(bytes).toString("utf8"));
}

export function receiptOwnsProject(receipt: BuildReceipt, buildDirectory: string): boolean {
  return ((receipt.kind === "tfsb-build-v2" && receipt.schemaVersion === 2) || (receipt.kind === "tfsb-build-v3" && receipt.schemaVersion === 3)) && receipt.buildDirectory === buildDirectory;
}
