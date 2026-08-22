import { createRequire } from "node:module";

const packageJson = createRequire(import.meta.url)("../package.json") as unknown;

if (
  typeof packageJson !== "object" ||
  packageJson === null ||
  !("version" in packageJson) ||
  typeof packageJson.version !== "string"
) {
  throw new Error("Package metadata does not contain a valid version.");
}

export const TOOL_VERSION = packageJson.version;
