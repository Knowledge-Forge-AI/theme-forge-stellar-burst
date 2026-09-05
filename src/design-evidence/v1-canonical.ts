import { createHash } from "node:crypto";
import { canonicalJson } from "../service-protocol/canonical-json.js";
import type { DesignEvidenceDigest, DesignEvidencePacketV1, DesignEvidencePacketKindV1 } from "./v1-types.js";

export const DESIGN_EVIDENCE_DOMAINS = {
  brief: "tfsb.design-brief-v1\n",
  candidate: "tfsb.design-candidate-v1\n",
  review: "tfsb.design-review-v1\n",
} as const;

export function designEvidencePacketKind(packet: DesignEvidencePacketV1): DesignEvidencePacketKindV1 {
  if (packet.schema === "tfsb.design-brief") return "brief";
  if (packet.schema === "tfsb.design-candidate") return "candidate";
  return "review";
}

export function canonicalDesignEvidenceJson(value: unknown): string {
  const canonical = JSON.parse(canonicalJson(value)) as unknown;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function digestProjection(packet: DesignEvidencePacketV1): Record<string, unknown> {
  const digestField = packet.schema === "tfsb.design-brief" ? "briefDigest" : packet.schema === "tfsb.design-candidate" ? "candidateDigest" : "reviewDigest";
  return Object.fromEntries(Object.entries(packet).filter(([key]) => key !== digestField));
}

export function computeDesignEvidenceDigest(packet: DesignEvidencePacketV1): DesignEvidenceDigest {
  const kind = designEvidencePacketKind(packet);
  const bytes = `${DESIGN_EVIDENCE_DOMAINS[kind]}${canonicalDesignEvidenceJson(digestProjection(packet))}`;
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}` as DesignEvidenceDigest;
}

export function serializeDesignEvidencePacket(packet: DesignEvidencePacketV1): string {
  return canonicalDesignEvidenceJson(packet);
}
