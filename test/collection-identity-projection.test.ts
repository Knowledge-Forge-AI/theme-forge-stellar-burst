import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";

import {
  deriveSourceMapId,
  portablePathIssue,
  shardProjection,
} from "../tools/project-v0.4-collection-identities.mjs";
import { stableJson } from "../tools/audit-dogfood-corpus.mjs";

describe("v0.4 collection identity projection", () => {
  it("keeps every proposed v0.4 TOML example syntactically valid", async () => {
    const names = [
      "collision-override-source-map.toml",
      "lucide-source-map.toml",
      "shard-manifest.toml",
      "simple-icons-source-map.toml",
      "tabler-source-map.toml",
      "terminal-nova-source-map.toml",
      "workspace.toml",
    ];
    for (const name of names) {
      const text = await readFile(`docs/examples/v0.4/${name}`, "utf8");
      expect(() => parseToml(text)).not.toThrow();
    }
  });

  it("derives closed basename and relative-path identities without suffix invention", () => {
    expect(deriveSourceMapId("activity.svg", "basename", "outline-")).toEqual({
      id: "outline-activity",
      valid: true,
      bytes: 16,
      overflow: false,
    });
    expect(deriveSourceMapId("brands/30 Seconds/default.svg", "relative-path")).toMatchObject({
      id: "brands-30-seconds-default",
      valid: true,
      overflow: false,
    });
    expect(deriveSourceMapId("a/b.svg", "relative-path").id).toBe(
      deriveSourceMapId("a-b.svg", "relative-path").id,
    );
  });

  it("reports automatic identity overflow instead of truncating or hashing", () => {
    const result = deriveSourceMapId(
      "aws-res-aws-application-discovery-service/aws-agentless-collector-default.svg",
      "relative-path",
    );
    expect(result.id).toBe(
      "aws-res-aws-application-discovery-service-aws-agentless-collector-default",
    );
    expect(result.bytes).toBe(73);
    expect(result.overflow).toBe(true);
  });

  it("detects portable path hazards independently of identity derivation", () => {
    expect(portablePathIssue("icons/valid-name.svg")).toBe(false);
    expect(portablePathIssue(".hidden/valid.svg")).toBe(false);
    expect(portablePathIssue(".hidden.svg")).toBe(false);
    expect(portablePathIssue("icons/CON.svg")).toBe(true);
    expect(portablePathIssue("icons/trailing-space .svg")).toBe(false);
    expect(portablePathIssue("icons/trailing-space.svg ")).toBe(true);
    expect(portablePathIssue("icons/ leading-space.svg")).toBe(true);
    expect(portablePathIssue("icons/trailing-dot.")).toBe(true);
    expect(portablePathIssue("icons/.")).toBe(true);
    expect(portablePathIssue("icons/..")).toBe(true);
  });

  it("freezes deterministic explicit shard membership", () => {
    const paths = ["c.svg", "a.svg", "b.svg"].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    const result = shardProjection(paths, 2);
    expect(result.membership).toEqual(["a.svg", "b.svg"]);
    expect(result.membershipSha256).toBe(
      `sha256:${createHash("sha256").update("a.svg\nb.svg\n").digest("hex")}`,
    );
  });

  it("keeps the committed projection canonical, private-path free, and review-corrected", async () => {
    const raw = await readFile(
      "docs/evaluations/v0.4-collection-identity-projection.json",
      "utf8",
    );
    const projection = JSON.parse(raw) as {
      kind: string;
      identityPolicy: { automaticOverrideModel: string };
      collections: Array<{
        collectionId: string;
        derivedIdentityOverflowCount: number;
        regularSvgPathCount: number;
      }>;
      tablerCrossCollectionIdentity: {
        withoutPrefixes: { groups: number; affectedFiles: number };
        withDisjointPrefixes: { groups: number; affectedFiles: number };
      };
    };
    expect(stableJson(projection)).toBe(raw);
    expect(raw).not.toContain("/Users/");
    const report = await readFile(
      "docs/evaluations/v0.4-collection-identity-projection.md",
      "utf8",
    );
    expect(report).toContain(createHash("sha256").update(raw).digest("hex"));
    expect(projection.kind).toBe("tfsb-v0.4-collection-identity-projection");
    expect(projection.identityPolicy.automaticOverrideModel).toBe(
      "basename-or-relative-path-plus-explicit-entry-overrides",
    );
    expect(projection.collections.map((collection) => collection.regularSvgPathCount)).toEqual([
      3453,
      1776,
      5130,
      1054,
      12446,
    ]);
    expect(projection.tablerCrossCollectionIdentity.withoutPrefixes).toMatchObject({
      groups: 1054,
      affectedFiles: 2108,
    });
    expect(projection.tablerCrossCollectionIdentity.withDisjointPrefixes).toMatchObject({
      groups: 0,
      affectedFiles: 0,
    });
    expect(
      projection.collections.find((collection) => collection.collectionId === "thesvg")
        ?.derivedIdentityOverflowCount,
    ).toBe(36);
  });
});
