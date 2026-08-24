import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Result } from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export function repoPath(relativePath: string): string {
  return join(repositoryRoot, relativePath);
}

export function readRepoFile(relativePath: string): string {
  return readFileSync(repoPath(relativePath), "utf8");
}

export function makeTempDir(prefix = "tfsb-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  return result.value;
}

export function firstCode<T>(result: Result<T>): string | undefined {
  return result.ok ? undefined : result.diagnostics[0]?.code;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
