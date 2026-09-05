import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bundleBrandProject,
  computeConsumerProfilesDomainDigest,
  loadCanonicalProject,
  parseBrandPackageToml,
  parseConsumerProfilesToml,
  serializeBrandPackageToml,
} from "../../src/index.js";

export const PROFILE_ID = "core-fixture-brand/basic";
export const PROFILE_TOML = `schema = "tfsb.consumer-profiles"
schema_version = 1
[[profiles]]
id = "basic"
version = 1
compatible_package = "core-fixture-brand"
minimum_brand_version = "0.4.0-fixture.1"
maximum_brand_version_exclusive = "1.0.0"
[[profiles.outputs]]
asset = "fixture-mark-on-light"
destination = "public/fixture-mark.svg"
requirement = "required"
collision = "error"
[[profiles.outputs]]
companion = "fixture-guidance"
destination = "GUIDANCE-BRAND.md"
requirement = "required"
collision = "error"
`;

function unwrap<T>(result: { ok: true; value: T } | { ok: false }): T { if (!result.ok) throw new Error("fixture parse failed"); return result.value; }

export async function createConsumerProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-consumer-"));
  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
  await writeFile(join(root, ".tfsb", "project.toml"), 'schema_version = 2\nname = "consumer"\n\n[build]\ndirectory = "dist"\n');
  return root;
}

export async function createConsumerBundle(options: { readonly profileToml?: string; readonly npmPackage?: { readonly name: string; readonly version: string }; readonly packageId?: string } = {}): Promise<{ root: string; archive: string }> {
  const source = join(process.cwd(), "docs/examples/v0.4/brand-system/core-minimal");
  const root = await mkdtemp(join(tmpdir(), "tfsb-consumer-producer-"));
  await cp(join(source, ".tfsb"), join(root, ".tfsb"), { recursive: true });
  await cp(join(source, "GUIDANCE.md"), join(root, "GUIDANCE.md"));
  const brandPath = join(root, ".tfsb", "brand.toml");
  await writeFile(brandPath, (await readFile(brandPath, "utf8")).replace("consumer_profiles = false", "consumer_profiles = true"));
  const packageId = options.packageId ?? "core-fixture-brand";
  const profileToml = options.profileToml ?? PROFILE_TOML.replaceAll("core-fixture-brand", packageId);
  await writeFile(join(root, ".tfsb", "consumer-profiles.toml"), profileToml);
  const profileModel = unwrap(parseConsumerProfilesToml(profileToml));
  const packagePath = join(root, ".tfsb", "brand-package.toml");
  const packageModel = unwrap(parseBrandPackageToml(await readFile(packagePath, "utf8")));
  const firstPackage = { ...packageModel, packageId, compatibleProfiles: profileModel.profiles.map((profile) => profile.id), consumerProfileDigest: computeConsumerProfilesDomainDigest(profileModel), ...(options.npmPackage === undefined ? {} : { npmPackage: options.npmPackage }) };
  await writeFile(packagePath, serializeBrandPackageToml(firstPackage));
  const loaded = await loadCanonicalProject(root, "bundle");
  if (loaded.brand?.brandSystemDigest === undefined) throw new Error("fixture system digest unavailable");
  await writeFile(packagePath, serializeBrandPackageToml({ ...firstPackage, brandSystemDigest: loaded.brand.brandSystemDigest }));
  const archive = join(root, "consumer-source.zip");
  await bundleBrandProject({ root, output: "consumer-source.zip" });
  return { root, archive };
}
