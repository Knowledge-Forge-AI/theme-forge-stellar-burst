import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

const protocol = join(process.cwd(), "protocol/tfsb-design-evidence-v1");
const json = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join(protocol, name), "utf8")) as T;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function assertClosedObjects(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertClosedObjects); return; }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "object") expect(record.additionalProperties).toBe(false);
  Object.values(record).forEach(assertClosedObjects);
}

describe("design-evidence machine parity", () => {
  it("keeps inventory grammars and exact limits frozen", async () => {
    const inventory = await json<{ grammars: Record<string, string>; limits: Record<string, number> }>("inventory.json");
    expect(inventory.grammars).toEqual({
      generalId: "^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$",
      packageId: "^(?:@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$",
      tokenBackground: "^token:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    });
    expect(inventory.limits).toMatchObject({ packetBytes: 16_777_216, visualBytes: 8_388_608, targets: 32, renderTuples: 16, candidates: 8, acceptanceCriteria: 64, prohibitedChanges: 64, sourcePackages: 8, profileIds: 32, parameterSelections: 32, parameterValues: 32, parameterValueBytes: 512, licenseExpressionBytes: 256, materials: 64, claims: 64, annotations: 128 });
  });

  it("keeps every JSON Schema object closed and critical enums exact", async () => {
    const schemas = await Promise.all(["brief.schema.json", "candidate.schema.json", "review.schema.json"].map((name) => json<Record<string, unknown>>(name)));
    schemas.forEach(assertClosedObjects);
    const review = schemas[2] as { $defs: { annotation: { properties: { artifactRole: { enum: string[] } } } } };
    expect(review.$defs.annotation.properties.artifactRole.enum).toEqual(["current", "baseline", "before", "after"]);
  });

  it("regenerates every machine record without drift", () => {
    expect(() => execFileSync(process.execPath, ["tools/generate-design-evidence-v1.mjs", "--check"], { cwd: process.cwd(), stdio: "pipe" })).not.toThrow();
  });

  it("binds inventory hashes and CLI validate/inspect to every golden example", async () => {
    const inventory = await json<{ examples: Array<{ name: string; sha256: string }>; negativeCorpus: { name: string; cases: number; sha256: string } }>("inventory.json");
    const io = { stdout: (_text: string) => undefined, stderr: (_text: string) => undefined };
    for (const example of inventory.examples) {
      const path = join(protocol, "examples", example.name);
      expect(hash(await readFile(path))).toBe(example.sha256);
      expect(await runCli(["evidence", "validate", path, "--json"], process.cwd(), io)).toBe(0);
      expect(await runCli(["evidence", "inspect", path, "--json"], process.cwd(), io)).toBe(0);
    }
    const corpus = await readFile(join(protocol, inventory.negativeCorpus.name));
    expect(hash(corpus)).toBe(inventory.negativeCorpus.sha256);
    expect((JSON.parse(corpus.toString("utf8")) as { cases: unknown[] }).cases).toHaveLength(inventory.negativeCorpus.cases);
  });
});
