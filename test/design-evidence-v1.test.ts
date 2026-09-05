import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import {
  computeDesignEvidenceDigest, parseDesignEvidencePacket, serializeDesignEvidencePacket,
  summarizeDesignEvidencePacket, validateDesignEvidencePacket, validateDesignEvidenceReviewLinks,
  type DesignBriefPacketV1, type DesignCandidatePacketV1, type DesignReviewPacketV1,
} from "../src/design-evidence/index.js";

const examples = join(process.cwd(), "protocol/tfsb-design-evidence-v1/examples");
const load = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join(examples, name), "utf8")) as T;
const bytes = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe("design evidence v1", () => {
  it.each(["brief.json", "candidate-a.json", "candidate-b.json", "review.json"])("round trips exact golden bytes for %s", async (name) => {
    const source = await readFile(join(examples, name));
    const packet = parseDesignEvidencePacket(source);
    expect(serializeDesignEvidencePacket(packet)).toBe(source.toString("utf8"));
    expect(parseDesignEvidencePacket(serializeDesignEvidencePacket(packet))).toEqual(packet);
    expect(Object.isFrozen(packet)).toBe(true);
  });

  it("rejects duplicate, unknown, missing, BOM, and noncanonical input", async () => {
    const brief = await load<DesignBriefPacketV1>("brief.json");
    expect(() => parseDesignEvidencePacket(bytes(brief).replace('"briefId":', '"briefId": "duplicate",\n  "briefId":'))).toThrow(/duplicate-free/u);
    expect(() => parseDesignEvidencePacket(bytes({ ...brief, unexpected: true }))).toThrow(/Unknown field/u);
    const { title: _title, ...missing } = brief; expect(() => parseDesignEvidencePacket(bytes(missing))).toThrow(/Missing field/u);
    expect(() => parseDesignEvidencePacket(`\uFEFF${bytes(brief)}`)).toThrow(/BOM/u);
    expect(() => parseDesignEvidencePacket(JSON.stringify(brief))).toThrow(/canonical/u);
  });

  it("rejects digest drift and non-NFC text while accepting ordinary protocol-like prose", async () => {
    const candidate = await load<DesignCandidatePacketV1>("candidate-a.json");
    expect(() => parseDesignEvidencePacket(bytes({ ...candidate, title: "Changed" }))).toThrow(/digest/u);
    const ordinary = { ...candidate, rationale: "Use file: and profile: as prose; compare https:// references and align / center labels.", candidateDigest: candidate.candidateDigest };
    ordinary.candidateDigest = computeDesignEvidenceDigest(ordinary); expect(() => parseDesignEvidencePacket(bytes(ordinary))).not.toThrow();
    const nonNfc = { ...candidate, title: "Cafe\u0301", candidateDigest: candidate.candidateDigest };
    nonNfc.candidateDigest = computeDesignEvidenceDigest(nonNfc); expect(() => parseDesignEvidencePacket(bytes(nonNfc))).toThrow(/NFC/u);
  });

  it("binds target, proposal, annotation, disposition, and provenance changes", async () => {
    const brief = await load<DesignBriefPacketV1>("brief.json");
    const candidate = await load<DesignCandidatePacketV1>("candidate-a.json");
    const review = await load<DesignReviewPacketV1>("review.json");
    expect(computeDesignEvidenceDigest({ ...brief, title: "Different" })).not.toBe(brief.briefDigest);
    expect(computeDesignEvidenceDigest({ ...candidate, rationale: "Different" })).not.toBe(candidate.candidateDigest);
    expect(computeDesignEvidenceDigest({ ...review, summary: "Different" })).not.toBe(review.reviewDigest);
  });

  it("rejects regions outside the normalized image", async () => {
    const review = await load<DesignReviewPacketV1>("review.json");
    const annotation = { ...review.annotations[1]!, scope: { kind: "region" as const, xMillionths: 900_000, yMillionths: 0, widthMillionths: 200_000, heightMillionths: 1 } };
    const changed = { ...review, annotations: [review.annotations[0]!, annotation] };
    const packet = { ...changed, reviewDigest: computeDesignEvidenceDigest(changed) };
    expect(() => validateDesignEvidencePacket(packet)).toThrow(/escapes/u);
  });

  it("validates review visual and artifact cross-links", async () => {
    const review = await load<DesignReviewPacketV1>("review.json");
    const candidates = [await load<DesignCandidatePacketV1>("candidate-a.json"), await load<DesignCandidatePacketV1>("candidate-b.json")];
    expect(() => validateDesignEvidenceReviewLinks(review, candidates)).not.toThrow();
    expect(() => validateDesignEvidenceReviewLinks(review, candidates.slice(0, 1))).toThrow(/candidate set/u);
  });

  it("independently rejects every shared negative-corpus case", async () => {
    const corpus = JSON.parse(await readFile(join(process.cwd(), "protocol/tfsb-design-evidence-v1/negative-corpus.json"), "utf8")) as { cases: Array<{ id: string; packet: unknown }> };
    expect(corpus.cases.length).toBeGreaterThanOrEqual(12);
    for (const entry of corpus.cases) expect(() => validateDesignEvidencePacket(entry.packet), entry.id).toThrow();
  });

  it("summaries omit PNG bytes and free-form packet bodies", async () => {
    const packet = await load<DesignCandidatePacketV1>("candidate-a.json");
    const output = JSON.stringify(summarizeDesignEvidencePacket(packet));
    expect(output).not.toContain("bytesBase64"); expect(output).not.toContain(packet.rationale); expect(output).not.toContain(packet.claims[0]!.message);
  });

  it("CLI validate and inspect are deterministic and reject symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tfsb-evidence-test-"));
    const packetPath = join(directory, "packet.tfsb-brief.json"); await writeFile(packetPath, await readFile(join(examples, "brief.json")));
    const output: string[] = [], error: string[] = []; const io = { stdout: (text: string) => output.push(text), stderr: (text: string) => error.push(text) };
    expect(await runCli(["evidence", "validate", packetPath, "--json"], process.cwd(), io)).toBe(0); expect(output.join("")).not.toContain("bytesBase64");
    output.length = 0; expect(await runCli(["evidence", "inspect", packetPath, "--json"], process.cwd(), io)).toBe(0); const first = output.join(""); output.length = 0; expect(await runCli(["evidence", "inspect", packetPath, "--json"], process.cwd(), io)).toBe(0); expect(output.join("")).toBe(first);
    const link = join(directory, "link.tfsb-brief.json"); await symlink(packetPath, link); expect(await runCli(["evidence", "validate", link], process.cwd(), io)).toBe(1);
  });
});
