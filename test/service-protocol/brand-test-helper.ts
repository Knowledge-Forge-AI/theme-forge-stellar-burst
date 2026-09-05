import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createDeriveProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-studio-brand-derive-"));
  const source = join(process.cwd(), "docs/examples/v0.4/brand-system/core-minimal/.tfsb");
  await cp(source, join(root, ".tfsb"), { recursive: true });
  for (const name of ["brand-package.toml", "brand-qa.toml", "consumer-profiles.toml", "brand-exports.toml"]) await rm(join(root, ".tfsb", name), { force: true });
  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
  await writeFile(join(root, ".tfsb", "brand.toml"), `schema = "tfsb.brand"
schema_version = 1
enabled_domains = { tokens = true, recipes = true, qa = false, consumer_profiles = false, package = false, exports = false }

[[families]]
id = "fixture-fam"
name = "Fixture Family"
required_roles = []
optional_roles = ["mark"]

[[variants]]
family = "fixture-fam"
id = "light"
backgrounds = ["light"]
color_mode = "full-color"
scale = "standard"
status = "primary"

[[variants]]
family = "fixture-fam"
id = "derived-dark"
backgrounds = ["dark"]
color_mode = "reversed"
scale = "standard"
status = "primary"

[[bindings]]
family = "fixture-fam"
role = "mark"
variant = "light"
asset = "fixture-mark-on-light"
authority = "source"

[[bindings]]
family = "fixture-fam"
role = "mark"
variant = "derived-dark"
asset = "fixture-mark-derived-dark"
authority = "derived"
`);
  await writeFile(join(root, ".tfsb", "brand-tokens.toml"), `schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "brand-blue"
value = "#0066CCFF"

[[colors]]
id = "unused-color"
value = "#FF0000FF"
`);
  await writeFile(join(root, ".tfsb", "brand-recipes.toml"), `schema = "tfsb.brand-recipes"
schema_version = 1

[[recipes]]
id = "recipe-derived-dark"
target_asset = "fixture-mark-derived-dark"
source_asset = "fixture-mark-on-light"

[[recipes.operations]]
operation = "replace-paint"
channel = "fill"
source_color = "#000000FF"
replacement_token = "brand-blue"
expected_occurrences = 1

[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`);
  return root;
}
