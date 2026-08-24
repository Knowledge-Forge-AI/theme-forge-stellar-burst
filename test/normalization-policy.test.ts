import { describe, expect, it } from "vitest";

import {
  computeNormalizationMapSha256,
  computeNormalizationPolicyDigest,
  createNormalizationPolicyIdentity,
  normalizationPolicyBytes,
  parseNormalizationMap,
  serializeNormalizationMap,
} from "../src/index.js";
import { unwrap } from "./helpers.js";

const MAP = `# formatting is not authority
schema_version = 1

[defaults]
unlabelled_mode = "consumer_labelled"

[[entry]]
accessibility = "decorative"
source = "icons/z.svg"

[[entry]]
source = "icons/a.svg"
accessibility = "consumer_labelled"
`;

describe("normalization map and exact-common policy identity", () => {
  it("canonicalizes the frozen schema-1 map shape and UTF-8 source ordering", () => {
    const parsed = unwrap(parseNormalizationMap(MAP));
    expect(serializeNormalizationMap(parsed)).toBe(`schema_version = 1

[defaults]
unlabelled_mode = "consumer_labelled"

[[entry]]
source = "icons/a.svg"
accessibility = "consumer_labelled"

[[entry]]
source = "icons/z.svg"
accessibility = "decorative"
`);
  });

  it("rejects unknown fields, duplicate authority, and unsafe source identities", () => {
    expect(parseNormalizationMap("schema_version = 1\nunknown = true\n").ok).toBe(false);
    expect(parseNormalizationMap('schema_version = 1\n[[entry]]\nsource = "icons/a.svg"\naccessibility = "decorative"\n[[entry]]\nsource = "ICONS/A.SVG"\naccessibility = "consumer_labelled"\n').ok).toBe(false);
    expect(parseNormalizationMap('schema_version = 1\n[[entry]]\nsource = "../a.svg"\naccessibility = "decorative"\n').ok).toBe(false);
  });

  it("uses the frozen compact-JSON policy basis and stable digest vectors", () => {
    const parsed = unwrap(parseNormalizationMap(MAP));
    expect(normalizationPolicyBytes("none")).toBe('tfsb-normalization-policy-v1\n{"policyId":"exact-common","policyVersion":1,"targetSchemaVersion":2,"mapSchemaVersion":1,"mapSha256":"none"}\n');
    expect(computeNormalizationMapSha256(parsed)).toBe("sha256:881096ee08db4fa5c6194ee5e24e29c575df6d4a2cd1600306802be713f2b5c2");
    expect(computeNormalizationPolicyDigest(parsed)).toBe("sha256:38c6bce5b6a8c7e71a3a19ffbf32da1d653dfe80053519efb56ee8d173eb9649");
    expect(computeNormalizationPolicyDigest()).toBe("sha256:055f6e969fad72e651ce1ad9ae5cac008e3b2d31748cd68ffa589c0e5052c68f");
  });

  it("ignores formatting and path while changing identity for semantic authority", () => {
    const first = unwrap(parseNormalizationMap(MAP, "/private/first.toml"));
    const equivalent = unwrap(parseNormalizationMap(serializeNormalizationMap(first), "/different/location.toml"));
    expect(createNormalizationPolicyIdentity(first)).toEqual(createNormalizationPolicyIdentity(equivalent));
    const changed = unwrap(parseNormalizationMap(serializeNormalizationMap({ ...first, defaultUnlabelledMode: "decorative" })));
    expect(createNormalizationPolicyIdentity(changed).policyDigest).not.toBe(createNormalizationPolicyIdentity(first).policyDigest);
    expect(JSON.stringify(createNormalizationPolicyIdentity(first))).not.toContain("/private/");
  });
});
