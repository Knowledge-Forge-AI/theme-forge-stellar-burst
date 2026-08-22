import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Result } from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export function readRepoFile(relativePath: string): string {
  return readFileSync(`${repositoryRoot}/${relativePath}`, "utf8");
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
