import { DiagnosticError, fail, type DiagnosticContext } from "../diagnostics.js";
import { compareUtf8 } from "../provenance.js";
import {
  BRAND_FILE_INVENTORY,
  BRAND_TOML_MAX_BYTES,
  isBrandBaselinePath,
  OPTIONAL_BRAND_DOMAINS,
  type BrandDomain,
  type BrandFileEntry,
  type BrandOptionalDomain,
} from "./brand-files.js";
import { parseBrandPackageToml, type BrandPackageModel } from "./brand-package.js";
import { parseBrandRecipesToml, type BrandRecipesModel } from "./recipes.js";
import { parseBrandQaToml, type BrandQaModel } from "./qa-schema.js";
import { parseBrandToml, type BrandModel } from "./brand-schema.js";
import { parseBrandTokensToml, type BrandTokensModel } from "./tokens.js";
import { parseConsumerProfilesToml, type ConsumerProfilesModel } from "./consumer-profile.js";
import { parseBrandExportsToml, type BrandExportsModel } from "./export-profile.js";

export type BrandDomainState = "disabled" | "available" | "declared-unavailable";

export interface BrandDomainAvailability {
  readonly domain: BrandDomain;
  readonly canonicalPath: string;
  readonly enabled: boolean;
  readonly state: BrandDomainState;
  readonly present: boolean;
}

export interface BrandDiscoveryResult {
  readonly branded: boolean;
  readonly brandModel?: BrandModel;
  readonly tokensModel?: BrandTokensModel;
  readonly recipesModel?: BrandRecipesModel;
  readonly qaModel?: BrandQaModel;
  readonly consumerProfilesModel?: ConsumerProfilesModel;
  readonly packageModel?: BrandPackageModel;
  readonly exportsModel?: BrandExportsModel;
  readonly domains: readonly BrandDomainAvailability[];
  readonly brandFiles: ReadonlyMap<string, Uint8Array>;
}

const DOMAIN_KEY_MAP: Record<BrandOptionalDomain, keyof BrandModel["enabledDomains"]> = {
  tokens: "tokens",
  recipes: "recipes",
  qa: "qa",
  consumer_profiles: "consumerProfiles",
  package: "package",
  exports: "exports",
};

export function discoverBrandState(
  snapshotFiles: ReadonlyMap<string, { readonly bytes: Uint8Array }>,
  ctx: DiagnosticContext,
): BrandDiscoveryResult {
  const brandFile = snapshotFiles.get(".tfsb/brand.toml");
  const otherBrandEntries = BRAND_FILE_INVENTORY.filter((entry) => entry.canonicalPath !== ".tfsb/brand.toml");

  if (brandFile === undefined) {
    for (const entry of otherBrandEntries) {
      if (entry.domain !== "consumer_profiles" && snapshotFiles.has(entry.canonicalPath)) {
        fail(
          ctx,
          "BRAND_MARKER_MISSING",
          "Fixed brand file '" + entry.canonicalPath + "' is present but presence marker '.tfsb/brand.toml' is missing.",
          entry.canonicalPath,
        );
      }
    }
    return {
      branded: false,
      domains: [],
      brandFiles: new Map(),
    };
  }

  let brandText: string;
  try {
    brandText = new TextDecoder("utf-8", { fatal: true }).decode(brandFile.bytes);
  } catch {
    fail(ctx, "SCHEMA_INVALID_SYNTAX", "brand.toml must be valid UTF-8.", ".tfsb/brand.toml");
  }
  const parseResult = parseBrandToml(brandText, ".tfsb/brand.toml");
  if (!parseResult.ok) {
    const diag = parseResult.diagnostics[0];
    if (diag !== undefined) {
      throw new DiagnosticError(diag);
    }
    fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand.toml");
  }
  const brandModel = parseResult.value;

  const brandFiles = new Map<string, Uint8Array>();
  brandFiles.set(".tfsb/brand.toml", brandFile.bytes);

  const domains: BrandDomainAvailability[] = [
    {
      domain: "brand",
      canonicalPath: ".tfsb/brand.toml",
      enabled: true,
      state: "available",
      present: true,
    },
  ];

  let tokensModel: BrandTokensModel | undefined;
  let recipesModel: BrandRecipesModel | undefined;
  let qaModel: BrandQaModel | undefined;
  let consumerProfilesModel: ConsumerProfilesModel | undefined;
  let packageModel: BrandPackageModel | undefined;
  let exportsModel: BrandExportsModel | undefined;

  for (const domain of OPTIONAL_BRAND_DOMAINS) {
    const entry = BRAND_FILE_INVENTORY.find((e) => e.domain === domain)!;
    const key = DOMAIN_KEY_MAP[domain];
    const isEnabled = brandModel.enabledDomains[key];
    const fileSnapshot = snapshotFiles.get(entry.canonicalPath);
    const isPresent = fileSnapshot !== undefined;

    if (isEnabled) {
      if (!isPresent) {
        fail(
          ctx,
          "BRAND_DOMAIN_FILE_MISSING",
          "Brand domain '" + domain + "' is declared enabled in brand.toml, but required file '" + entry.canonicalPath + "' is missing.",
          entry.canonicalPath,
        );
      }
      brandFiles.set(entry.canonicalPath, fileSnapshot.bytes);

      if (domain === "tokens") {
        let tokText: string;
        try {
          tokText = new TextDecoder("utf-8", { fatal: true }).decode(fileSnapshot.bytes);
        } catch {
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "brand-tokens.toml must be valid UTF-8.", ".tfsb/brand-tokens.toml");
        }
        const tokResult = parseBrandTokensToml(tokText, ".tfsb/brand-tokens.toml");
        if (!tokResult.ok) {
          const diag = tokResult.diagnostics[0];
          if (diag !== undefined) {
            throw new DiagnosticError(diag);
          }
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-tokens.toml");
        }
        tokensModel = tokResult.value;

        domains.push({
          domain,
          canonicalPath: entry.canonicalPath,
          enabled: true,
          state: "available",
          present: true,
        });
      } else if (domain === "recipes") {
        let recText: string;
        try {
          recText = new TextDecoder("utf-8", { fatal: true }).decode(fileSnapshot.bytes);
        } catch {
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "brand-recipes.toml must be valid UTF-8.", ".tfsb/brand-recipes.toml");
        }
        const recResult = parseBrandRecipesToml(recText, ".tfsb/brand-recipes.toml");
        if (!recResult.ok) {
          const diag = recResult.diagnostics[0];
          if (diag !== undefined) {
            throw new DiagnosticError(diag);
          }
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-recipes.toml");
        }
        recipesModel = recResult.value;

        domains.push({
          domain,
          canonicalPath: entry.canonicalPath,
          enabled: true,
          state: "available",
          present: true,
        });
      } else if (domain === "qa") {
        let qaText: string;
        try {
          qaText = new TextDecoder("utf-8", { fatal: true }).decode(fileSnapshot.bytes);
        } catch {
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "brand-qa.toml must be valid UTF-8.", ".tfsb/brand-qa.toml");
        }
        const qaResult = parseBrandQaToml(qaText, ".tfsb/brand-qa.toml");
        if (!qaResult.ok) {
          const diag = qaResult.diagnostics[0];
          if (diag !== undefined) throw new DiagnosticError(diag);
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-qa.toml");
        }
        qaModel = qaResult.value;
        domains.push({ domain, canonicalPath: entry.canonicalPath, enabled: true, state: "available", present: true });
      } else if (domain === "package") {
        let pkgText: string;
        try {
          pkgText = new TextDecoder("utf-8", { fatal: true }).decode(fileSnapshot.bytes);
        } catch {
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "brand-package.toml must be valid UTF-8.", ".tfsb/brand-package.toml");
        }
        const pkgResult = parseBrandPackageToml(pkgText, ".tfsb/brand-package.toml");
        if (!pkgResult.ok) {
          const diag = pkgResult.diagnostics[0];
          if (diag !== undefined) {
            throw new DiagnosticError(diag);
          }
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-package.toml");
        }
        packageModel = pkgResult.value;

        domains.push({
          domain,
          canonicalPath: entry.canonicalPath,
          enabled: true,
          state: "available",
          present: true,
        });
      } else if (domain === "consumer_profiles") {
        let profileText: string;
        try {
          profileText = new TextDecoder("utf-8", { fatal: true }).decode(fileSnapshot.bytes);
        } catch {
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "consumer-profiles.toml must be valid UTF-8.", entry.canonicalPath);
        }
        const profileResult = parseConsumerProfilesToml(profileText, entry.canonicalPath);
        if (!profileResult.ok) {
          const diag = profileResult.diagnostics[0];
          if (diag !== undefined) throw new DiagnosticError(diag);
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse consumer-profiles.toml.", entry.canonicalPath);
        }
        consumerProfilesModel = profileResult.value;
        domains.push({ domain, canonicalPath: entry.canonicalPath, enabled: true, state: "available", present: true });
      } else if (domain === "exports") {
        let exportsText: string;
        try {
          exportsText = new TextDecoder("utf-8", { fatal: true }).decode(fileSnapshot.bytes);
        } catch {
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "brand-exports.toml must be valid UTF-8.", entry.canonicalPath);
        }
        const exportsResult = parseBrandExportsToml(exportsText, entry.canonicalPath);
        if (!exportsResult.ok) {
          const diag = exportsResult.diagnostics[0];
          if (diag !== undefined) throw new DiagnosticError(diag);
          fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-exports.toml.", entry.canonicalPath);
        }
        exportsModel = exportsResult.value;
        domains.push({ domain, canonicalPath: entry.canonicalPath, enabled: true, state: "available", present: true });
      }
    } else {
      if (isPresent) {
        fail(
          ctx,
          "BRAND_DOMAIN_FILE_PRESENT_WHEN_DISABLED",
          "Brand domain '" + domain + "' is disabled in brand.toml, but file '" + entry.canonicalPath + "' is present.",
          entry.canonicalPath,
        );
      }
      domains.push({
        domain,
        canonicalPath: entry.canonicalPath,
        enabled: false,
        state: "disabled",
        present: false,
      });
    }
  }

  domains.sort((a, b) => compareUtf8(a.domain, b.domain));

  const baselinePaths = [...snapshotFiles.keys()].filter(isBrandBaselinePath).sort(compareUtf8);
  if (baselinePaths.length > 0 && qaModel === undefined) fail(ctx, "BRAND_QA_BASELINES_WITHOUT_QA", "Brand baselines require enabled, valid QA authority.", baselinePaths[0]);
  if (qaModel !== undefined) {
    const owned = new Set(qaModel.cases.filter((entry) => entry.kind === "baseline").map((entry) => entry.kind === "baseline" ? entry.baselinePath : ""));
    for (const path of baselinePaths) if (!owned.has(path)) fail(ctx, "BRAND_QA_BASELINE_UNOWNED", `Baseline '${path}' has no matching QA case metadata.`, path);
  }

  return {
    branded: true,
    brandModel,
    ...(tokensModel === undefined ? {} : { tokensModel }),
    ...(recipesModel === undefined ? {} : { recipesModel }),
    ...(qaModel === undefined ? {} : { qaModel }),
    ...(consumerProfilesModel === undefined ? {} : { consumerProfilesModel }),
    ...(packageModel === undefined ? {} : { packageModel }),
    ...(exportsModel === undefined ? {} : { exportsModel }),
    domains: Object.freeze(domains),
    brandFiles,
  };
}
