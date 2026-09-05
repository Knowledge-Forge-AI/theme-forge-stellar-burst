import { describe, expect, it } from "vitest";

import {
  computeConsumerProfileDigest,
  computeConsumerProfilesDomainDigest,
  isBrandVersionCompatible,
  parseConsumerProfilesToml,
  serializeConsumerProfilesToml,
} from "../../src/brand/consumer-profile.js";

const fixture = `schema = "tfsb.consumer-profiles"
schema_version = 1

[[profiles]]
id = "astro-starlight"
version = 1
compatible_package = "terminal-nova-brand"
minimum_brand_version = "0.4.0-example.1"
maximum_brand_version_exclusive = "1.0.0"
composes = []

[[profiles.parameters]]
id = "theme"
values = ["light", "dark"]

[[profiles.outputs]]
family = "terminal-nova"
role = "favicon"
variant = "favicon-on-light"
destination_directory = "docs/public"
filename_policy = "asset-id.svg"
requirement = "required"
collision = "error"

[[profiles.outputs.when]]
parameter = "theme"
equals = "light"

[[profiles.outputs]]
companion = "terminal-nova-brand-guidance"
destination = "README-BRAND.md"
requirement = "required"
collision = "error"
`;

function parsed() {
  const result = parseConsumerProfilesToml(fixture);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result.value;
}

describe("consumer profile schema 1", () => {
  it("canonicalizes, serializes, and reparses exact closed semantics", () => {
    const model = parsed();
    expect(model.profiles[0]?.qualifiedId).toBe("terminal-nova-brand/astro-starlight");
    const serialized = serializeConsumerProfilesToml(model);
    const again = parseConsumerProfilesToml(serialized);
    expect(again).toEqual({ ok: true, value: model });
    expect(serializeConsumerProfilesToml((again as { ok: true; value: typeof model }).value)).toBe(serialized);
  });

  it("has deterministic domain and individual digest vectors", () => {
    const model = parsed();
    expect(computeConsumerProfilesDomainDigest(model)).toBe("sha256:e627e3b1e1a695010a201f7bc8e12d8a9a2c8095f051e3c838b22fa4961e4be0");
    expect(computeConsumerProfileDigest(model.profiles[0]!)).toBe("sha256:d082064eab7033df6cba3c6b9000e13dcf5c1d9fb402969304746a9b1a1bdbc7");
    expect(computeConsumerProfilesDomainDigest(model)).toBe(computeConsumerProfilesDomainDigest(parsed()));
  });

  it("applies inclusive minimum and exclusive maximum SemVer bounds", () => {
    const profile = parsed().profiles[0]!;
    expect(isBrandVersionCompatible(profile, "0.4.0-example.1")).toBe(true);
    expect(isBrandVersionCompatible(profile, "0.4.0")).toBe(true);
    expect(isBrandVersionCompatible(profile, "1.0.0")).toBe(false);
  });

  it.each([
    ["alias selector", fixture.replace('companion = "terminal-nova-brand-guidance"', 'source = "README.md"')],
    ["parameter interpolation", fixture.replace('destination = "README-BRAND.md"', 'destination = "${theme}/README.md"')],
    ["partial binding", fixture.replace('role = "favicon"\nvariant = "favicon-on-light"\n', "")],
    ["bad range", fixture.replace('maximum_brand_version_exclusive = "1.0.0"', 'maximum_brand_version_exclusive = "0.4.0-example.1"')],
    ["companion asset filename policy", fixture.replace('destination = "README-BRAND.md"', 'destination_directory = "docs"\nfilename_policy = "asset-id.svg"')],
    ["protected destination", fixture.replace('destination = "README-BRAND.md"', 'destination = ".tfsb/brand.lock.json"')],
    ["absolute destination", fixture.replace('destination = "README-BRAND.md"', 'destination = "/tmp/output"')],
    ["parent destination", fixture.replace('destination = "README-BRAND.md"', 'destination = "../output"')],
    ["backslash destination", fixture.replace('destination = "README-BRAND.md"', 'destination = "docs\\\\output"')],
    ["reserved destination", fixture.replace('destination = "README-BRAND.md"', 'destination = "public/CON.svg"')],
    ["trailing-dot destination", fixture.replace('destination = "README-BRAND.md"', 'destination = "public./output"')],
  ])("rejects %s", (_name, source) => {
    expect(parseConsumerProfilesToml(source).ok).toBe(false);
  });

  it("accepts exact collection boundaries and rejects boundary plus one", () => {
    const profile = (index: number) => `\n[[profiles]]\nid = "profile-${index}"\nversion = 1\ncompatible_package = "pkg"\n[[profiles.outputs]]\nasset = "asset"\ndestination = "out/${index}.svg"\nrequirement = "required"\ncollision = "error"\n`;
    const file = (count: number) => `schema = "tfsb.consumer-profiles"\nschema_version = 1\n${Array.from({ length: count }, (_, index) => profile(index)).join("")}`;
    expect(parseConsumerProfilesToml(file(32)).ok).toBe(true);
    expect(parseConsumerProfilesToml(file(33)).ok).toBe(false);

    const rule = (index: number) => `\n[[profiles.outputs]]\nasset = "asset"\ndestination = "out/${index}.svg"\nrequirement = "required"\ncollision = "error"\n`;
    const rules = (count: number) => `schema = "tfsb.consumer-profiles"\nschema_version = 1\n[[profiles]]\nid = "many"\nversion = 1\ncompatible_package = "pkg"\n${Array.from({ length: count }, (_, index) => rule(index)).join("")}`;
    expect(parseConsumerProfilesToml(rules(256)).ok).toBe(true);
    expect(parseConsumerProfilesToml(rules(257)).ok).toBe(false);
  });

  it("enforces parameter, value, and direct-composition boundaries", () => {
    const parameter = (index: number, values = 16) => `\n[[profiles.parameters]]\nid = "param-${index}"\nvalues = [${Array.from({ length: values }, (_, value) => `"value-${value}"`).join(", ")}]\n`;
    const source = (parameters: number, values = 16, composes = 4) => `schema = "tfsb.consumer-profiles"\nschema_version = 1\n[[profiles]]\nid = "bounded"\nversion = 1\ncompatible_package = "pkg"\ncomposes = [${Array.from({ length: composes }, (_, index) => `"pkg/child-${index}"`).join(", ")}]\n${Array.from({ length: parameters }, (_, index) => parameter(index, index === 0 ? values : 1)).join("")}\n[[profiles.outputs]]\nasset = "asset"\ndestination = "out.svg"\nrequirement = "required"\ncollision = "error"\n`;
    expect(parseConsumerProfilesToml(source(16)).ok).toBe(true);
    expect(parseConsumerProfilesToml(source(17)).ok).toBe(false);
    expect(parseConsumerProfilesToml(source(1, 17)).ok).toBe(false);
    expect(parseConsumerProfilesToml(source(1, 1, 5)).ok).toBe(false);
  });
});
