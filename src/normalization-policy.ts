import { computeSha256, type Sha256Digest } from "./digests.js";
import { NORMALIZATION_MAP_SCHEMA_VERSION, serializeNormalizationMap, type NormalizationMapV1 } from "./normalization-map.js";
import { TOOL_VERSION } from "./version.js";

export const NORMALIZATION_POLICY_BASIS = "tfsb-normalization-policy-v1" as const;
export const NORMALIZATION_POLICY_ID = "exact-common" as const;
export const NORMALIZATION_POLICY_VERSION = 1 as const;
export const NORMALIZATION_TARGET_SCHEMA_VERSION = 2 as const;

export type MapSha256 = Sha256Digest | "none";

export interface NormalizationPolicyIdentityV1 {
  readonly policyBasis: typeof NORMALIZATION_POLICY_BASIS;
  readonly policyId: typeof NORMALIZATION_POLICY_ID;
  readonly policyVersion: typeof NORMALIZATION_POLICY_VERSION;
  readonly targetSchemaVersion: typeof NORMALIZATION_TARGET_SCHEMA_VERSION;
  readonly mapSchemaVersion: typeof NORMALIZATION_MAP_SCHEMA_VERSION;
  readonly mapSha256: MapSha256;
  readonly policyDigest: Sha256Digest;
  readonly implementationVersion: string;
}

export function computeNormalizationMapSha256(map?: NormalizationMapV1): MapSha256 {
  return map === undefined ? "none" : computeSha256(Buffer.from(serializeNormalizationMap(map), "utf8"));
}

export function normalizationPolicyBytes(mapSha256: MapSha256): string {
  const record = {
    policyId: NORMALIZATION_POLICY_ID,
    policyVersion: NORMALIZATION_POLICY_VERSION,
    targetSchemaVersion: NORMALIZATION_TARGET_SCHEMA_VERSION,
    mapSchemaVersion: NORMALIZATION_MAP_SCHEMA_VERSION,
    mapSha256,
  };
  return `${NORMALIZATION_POLICY_BASIS}\n${JSON.stringify(record)}\n`;
}

export function computeNormalizationPolicyDigest(map?: NormalizationMapV1): Sha256Digest {
  return computeSha256(Buffer.from(normalizationPolicyBytes(computeNormalizationMapSha256(map)), "ascii"));
}

export function createNormalizationPolicyIdentity(map?: NormalizationMapV1): NormalizationPolicyIdentityV1 {
  const mapSha256 = computeNormalizationMapSha256(map);
  return {
    policyBasis: NORMALIZATION_POLICY_BASIS,
    policyId: NORMALIZATION_POLICY_ID,
    policyVersion: NORMALIZATION_POLICY_VERSION,
    targetSchemaVersion: NORMALIZATION_TARGET_SCHEMA_VERSION,
    mapSchemaVersion: NORMALIZATION_MAP_SCHEMA_VERSION,
    mapSha256,
    policyDigest: computeSha256(Buffer.from(normalizationPolicyBytes(mapSha256), "ascii")),
    implementationVersion: TOOL_VERSION,
  };
}

export function normalizationPolicyMatches(left: NormalizationPolicyIdentityV1, right: NormalizationPolicyIdentityV1): boolean {
  return left.policyBasis === right.policyBasis && left.policyId === right.policyId && left.policyVersion === right.policyVersion &&
    left.targetSchemaVersion === right.targetSchemaVersion && left.mapSchemaVersion === right.mapSchemaVersion &&
    left.mapSha256 === right.mapSha256 && left.policyDigest === right.policyDigest;
}
