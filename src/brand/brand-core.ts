import { DiagnosticError, fail, type DiagnosticContext } from "../diagnostics.js";
import { computeAssetSemanticDigest, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { AnyNormalizedAsset } from "../schema-dispatch.js";
import {
  discoverBrandState,
  type BrandDomainAvailability,
  type BrandDomainState,
} from "./brand-availability.js";
import { computeBrandDigest, computeBrandSystemDigest } from "./brand-digests.js";
import { computeBrandPackageDigest, type BrandPackageModel } from "./brand-package.js";
import { computeConsumerProfilesDomainDigest, type ConsumerProfilesModel } from "./consumer-profile.js";
import { computeBrandExportsDomainDigest, computeRawBrandExportsFileDigest, validateBrandExportSemantics, type BrandExportsModel } from "./export-profile.js";
import { computeBrandQaDigest, toBrandQaCanonicalDto, type BrandQaModel } from "./qa-schema.js";
import {
  buildRecipeGraph,
  computeBrandRecipesDigest,
  toBrandRecipesCanonicalDto,
  type BrandRecipesModel,
} from "./recipes.js";
import {
  computeBrandTokensDigest,
  findUnusedTokens,
  toBrandTokensCanonicalDto,
  type BrandTokensModel,
} from "./tokens.js";
import {
  BRAND_BACKGROUNDS,
  BRAND_SCALES,
  type BrandBackground,
  type BrandBinding,
  type BrandModel,
  type BrandRequirement,
  type BrandVariant,
} from "./brand-schema.js";

export interface LoadedBrandProject {
  readonly model: BrandModel;
  readonly tokensModel?: BrandTokensModel;
  readonly recipesModel?: BrandRecipesModel;
  readonly qaModel?: BrandQaModel;
  readonly consumerProfilesModel?: ConsumerProfilesModel;
  readonly packageModel?: BrandPackageModel;
  readonly exportsModel?: BrandExportsModel;
  readonly brandDigest: Sha256Digest;
  readonly tokensDigest?: Sha256Digest;
  readonly recipesDigest?: Sha256Digest;
  readonly qaDigest?: Sha256Digest;
  readonly consumerProfilesDigest?: Sha256Digest;
  readonly exportsDigest?: Sha256Digest;
  readonly rawExportsFileDigest?: Sha256Digest;
  readonly brandSystemDigest?: Sha256Digest;
  readonly brandPackageDigest?: Sha256Digest;
  readonly tokenWarnings?: readonly string[];
  readonly domains: readonly BrandDomainAvailability[];
  readonly brandFiles: ReadonlyMap<string, Uint8Array>;
  readonly referencedAssets: readonly {
    readonly assetId: string;
    readonly canonicalAssetDigest: string;
  }[];
  readonly completeness: {
    readonly satisfied: boolean;
    readonly familyCount: number;
    readonly variantCount: number;
    readonly bindingCount: number;
    readonly requirementCount: number;
  };
}

export function validateBrandSemantics(
  model: BrandModel,
  assetMap: ReadonlyMap<string, AnyNormalizedAsset>,
  ctx: DiagnosticContext,
  recipesModel?: BrandRecipesModel,
): {
  readonly referencedAssets: readonly {
    readonly assetId: string;
    readonly canonicalAssetDigest: string;
  }[];
  readonly completeness: {
    readonly satisfied: boolean;
    readonly familyCount: number;
    readonly variantCount: number;
    readonly bindingCount: number;
    readonly requirementCount: number;
  };
} {
  const familyMap = new Map<string, {
    readonly requiredRoles: Set<string>;
    readonly optionalRoles: Set<string>;
    readonly declaredRoles: Set<string>;
  }>();

  for (const family of model.families) {
    const requiredRoles = new Set(family.requiredRoles);
    const optionalRoles = new Set(family.optionalRoles);
    const declaredRoles = new Set([...requiredRoles, ...optionalRoles]);
    familyMap.set(family.id, { requiredRoles, optionalRoles, declaredRoles });
  }

  // Also add roles from requirements
  if (model.requirements !== undefined) {
    for (const req of model.requirements) {
      const fam = familyMap.get(req.family);
      if (fam !== undefined) {
        fam.declaredRoles.add(req.role);
      }
    }
  }

  const variantMap = new Map<string, BrandVariant>();
  for (const variant of model.variants) {
    variantMap.set(variant.family + ":" + variant.id, variant);
  }

  const recipeTargetAssets = new Set<string>();
  if (recipesModel !== undefined) {
    for (const r of recipesModel.recipes) {
      recipeTargetAssets.add(r.target_asset);
    }
  }

  // Validate bindings
  const referencedAssetIds = new Set<string>();
  let missingDerivedAsset = false;
  for (let i = 0; i < model.bindings.length; i++) {
    const binding = model.bindings[i]!;
    const loc = "bindings[" + i + "]";

    // Family exists
    const fam = familyMap.get(binding.family);
    if (fam === undefined) {
      fail(ctx, "BRAND_UNKNOWN_FAMILY", "Binding references unknown family '" + binding.family + "'.", loc + ".family");
    }

    // Variant exists and belongs to family
    const variant = variantMap.get(binding.family + ":" + binding.variant);
    if (variant === undefined) {
      fail(ctx, "BRAND_UNKNOWN_VARIANT", "Binding references unknown variant '" + binding.variant + "' in family '" + binding.family + "'.", loc + ".variant");
    }

    // Role is declared in family
    if (!fam.declaredRoles.has(binding.role)) {
      fail(
        ctx,
        "BRAND_UNDECLARED_ROLE",
        "Role '" + binding.role + "' is bound in family '" + binding.family + "' but is not declared in required_roles, optional_roles, or requirements.",
        loc + ".role",
      );
    }

    // Asset exists in canonical project
    const asset = assetMap.get(binding.asset);
    if (asset === undefined) {
      const recipeTargetPlaceholder = recipeTargetAssets.has(binding.asset);
      if (!recipeTargetPlaceholder) {
        fail(ctx, "BRAND_UNKNOWN_ASSET", "Binding references unknown canonical asset '" + binding.asset + "'.", loc + ".asset");
      }
      missingDerivedAsset = true;
    } else {
      referencedAssetIds.add(binding.asset);
    }

    // Authority checks
    if (binding.authority === "derived") {
      if (!model.enabledDomains.recipes) {
        fail(
          ctx,
          "BRAND_RECIPE_CAPABILITY_UNAVAILABLE",
          "Derived brand binding for asset '" + binding.asset + "' requires recipes domain to be enabled in brand.toml.",
          loc + ".authority",
        );
      }
      if (recipesModel !== undefined && !recipeTargetAssets.has(binding.asset)) {
        fail(
          ctx,
          "BRAND_RECIPE_TARGET_UNBOUND",
          "Derived brand binding for asset '" + binding.asset + "' does not match any recipe target in brand-recipes.toml.",
          loc + ".asset",
        );
      }
    } else if (binding.authority === "source") {
      if (recipesModel !== undefined && recipeTargetAssets.has(binding.asset)) {
        // The shared derived-state inspector classifies this ownership conflict
        // so check/list can report it and every mutating consumer can block it
        // with one authority contract.
        missingDerivedAsset = true;
      }
    }
  }

  // Primary ambiguity check
  const concreteBackgrounds: BrandBackground[] = ["light", "dark", "transparent"];
  const scales = BRAND_SCALES;

  for (const family of model.families) {
    const famBindings = model.bindings.filter((b) => b.family === family.id);
    const rolesInFam = new Set(famBindings.map((b) => b.role));

    for (const role of rolesInFam) {
      const roleBindings = famBindings.filter((b) => b.role === role);
      for (const bg of concreteBackgrounds) {
        for (const scale of scales) {
          const primaryMatches = roleBindings.filter((b) => {
            const v = variantMap.get(b.family + ":" + b.variant)!;
            if (v.status !== "primary") return false;
            if (v.scale !== scale) return false;
            return v.backgrounds.includes("any") || v.backgrounds.includes(bg);
          });
          if (primaryMatches.length > 1) {
            fail(
              ctx,
              "BRAND_PRIMARY_AMBIGUITY",
              "Primary binding ambiguity in family '" + family.id + "', role '" + role + "' for background '" + bg + "' and scale '" + scale + "' (" + primaryMatches.length + " primary matches).",
              "bindings",
            );
          }
        }
      }
    }
  }

  // Completeness check
  let requirementCount = 0;
  for (const family of model.families) {
    const famBindings = model.bindings.filter((b) => b.family === family.id);

    // 1. Unconstrained required_roles: must resolve to exactly one primary binding
    for (const reqRole of family.requiredRoles) {
      requirementCount++;
      const matchingPrimaryBindings = famBindings.filter((b) => {
        if (b.role !== reqRole) return false;
        const v = variantMap.get(b.family + ":" + b.variant)!;
        return v.status === "primary";
      });
      if (matchingPrimaryBindings.length === 0) {
        fail(
          ctx,
          "BRAND_REQUIREMENT_UNSATISFIED",
          "Required role '" + reqRole + "' in family '" + family.id + "' resolved to 0 primary bindings.",
          "families",
        );
      }
      if (matchingPrimaryBindings.length > 1) {
        fail(
          ctx,
          "BRAND_REQUIREMENT_AMBIGUOUS",
          "Required role '" + reqRole + "' in family '" + family.id + "' resolved to " + matchingPrimaryBindings.length + " primary bindings without constraints.",
          "families",
        );
      }
    }

    // 2. Constrained requirements
    const famRequirements = (model.requirements ?? []).filter((r) => r.family === family.id);
    for (let ri = 0; ri < famRequirements.length; ri++) {
      requirementCount++;
      const req = famRequirements[ri]!;
      const matches = famBindings.filter((b) => {
        if (b.role !== req.role) return false;
        const v = variantMap.get(b.family + ":" + b.variant)!;
        if (req.background !== undefined) {
          if (req.background === "any") {
            if (!v.backgrounds.includes("any")) return false;
          } else {
            if (!v.backgrounds.includes("any") && !v.backgrounds.includes(req.background)) return false;
          }
        }
        if (req.colorMode !== undefined && v.colorMode !== req.colorMode) return false;
        if (req.scale !== undefined && v.scale !== req.scale) return false;
        return true;
      });

      if (matches.length === 0) {
        fail(
          ctx,
          "BRAND_REQUIREMENT_UNSATISFIED",
          "Constrained requirement for family '" + family.id + "', role '" + req.role + "' resolved to 0 matching bindings.",
          "requirements[" + ri + "]",
        );
      }
      if (matches.length > 1) {
        fail(
          ctx,
          "BRAND_REQUIREMENT_AMBIGUOUS",
          "Constrained requirement for family '" + family.id + "', role '" + req.role + "' resolved to " + matches.length + " matching bindings.",
          "requirements[" + ri + "]",
        );
      }
    }
  }

  // Compute referenced assets semantic digests
  const sortedReferencedAssetIds = [...referencedAssetIds].sort(compareUtf8);
  const referencedAssets = sortedReferencedAssetIds.map((id) => {
    const asset = assetMap.get(id);
    if (asset === undefined) throw new Error("Validated referenced brand asset unexpectedly disappeared.");
    return {
      assetId: id,
      canonicalAssetDigest: computeAssetSemanticDigest(asset),
    };
  });

  return {
    referencedAssets: Object.freeze(referencedAssets),
    completeness: Object.freeze({
      satisfied: !missingDerivedAsset,
      familyCount: model.families.length,
      variantCount: model.variants.length,
      bindingCount: model.bindings.length,
      requirementCount,
    }),
  };
}

export function loadBrandProject(
  snapshotFiles: ReadonlyMap<string, { readonly bytes: Uint8Array }>,
  assetMap: ReadonlyMap<string, AnyNormalizedAsset>,
  ctx: DiagnosticContext,
): LoadedBrandProject | undefined {
  const discovery = discoverBrandState(snapshotFiles, ctx);
  if (!discovery.branded || discovery.brandModel === undefined) {
    return undefined;
  }

  if (discovery.recipesModel !== undefined) {
    buildRecipeGraph(discovery.recipesModel, ctx);
  }

  const { referencedAssets, completeness } = validateBrandSemantics(
    discovery.brandModel,
    assetMap,
    ctx,
    discovery.recipesModel,
  );
  const brandDigest = computeBrandDigest(discovery.brandModel);

  let tokensDigest: Sha256Digest | undefined;
  let tokenWarnings: readonly string[] | undefined;
  if (discovery.tokensModel !== undefined) {
    tokensDigest = computeBrandTokensDigest(discovery.tokensModel);
    // Find unused tokens across all referenced assets / recipes
    const usedTokenIds = new Set<string>();
    if (discovery.recipesModel !== undefined) {
      for (const recipe of discovery.recipesModel.recipes) {
        for (const op of recipe.operations) {
          if (op.operation === "replace-paint") usedTokenIds.add(op.replacement_token);
          else if (op.operation === "monochrome") usedTokenIds.add(op.color_token);
          else if (op.operation === "background-plate") usedTokenIds.add(op.color_token);
        }
      }
    }
    const unused = findUnusedTokens(discovery.tokensModel, usedTokenIds);
    if (unused.length > 0) {
      tokenWarnings = Object.freeze(unused.map((id) => "BRAND_TOKEN_UNUSED: Token '" + id + "' is declared in brand-tokens.toml but never referenced."));
    }
  }

  let recipesDigest: Sha256Digest | undefined;
  if (discovery.recipesModel !== undefined) {
    recipesDigest = computeBrandRecipesDigest(discovery.recipesModel);
  }

  const qaDigest = discovery.qaModel === undefined ? undefined : computeBrandQaDigest(discovery.qaModel);
  const consumerProfilesDigest = discovery.consumerProfilesModel === undefined ? undefined : computeConsumerProfilesDomainDigest(discovery.consumerProfilesModel);
  const exportsDigest = discovery.exportsModel === undefined ? undefined : computeBrandExportsDomainDigest(discovery.exportsModel);
  const rawExportsFileDigest = discovery.exportsModel === undefined ? undefined : computeRawBrandExportsFileDigest(discovery.exportsModel);

  if (discovery.exportsModel !== undefined) {
    validateBrandExportSemantics(discovery.exportsModel, discovery.brandModel, discovery.tokensModel, assetMap, ctx);
    if (discovery.packageModel === undefined) fail(ctx, "BRAND_PACKAGE_REQUIRED", "Enabled exports require an enabled brand package.", ".tfsb/brand-package.toml");
    if (discovery.packageModel.exportProfileDigest !== exportsDigest) fail(ctx, "BRAND_PACKAGE_EXPORT_DIGEST_MISMATCH", "brand-package.toml export_profile_digest must equal the export domain digest.", ".tfsb/brand-package.toml");
  }

  if (discovery.consumerProfilesModel !== undefined) {
    if (discovery.packageModel === undefined) fail(ctx, "BRAND_PACKAGE_REQUIRED", "Producer consumer profiles require an enabled brand package.", ".tfsb/brand-package.toml");
    for (const profile of discovery.consumerProfilesModel.profiles) {
      if (profile.compatiblePackage !== discovery.packageModel.packageId) fail(ctx, "CONSUMER_PROFILE_PACKAGE_MISMATCH", `Producer profile '${profile.id}' targets package '${profile.compatiblePackage}' instead of '${discovery.packageModel.packageId}'.`, ".tfsb/consumer-profiles.toml");
    }
    const profileIds = discovery.consumerProfilesModel.profiles.map((profile) => profile.id).sort(compareUtf8);
    if (profileIds.length !== discovery.packageModel.compatibleProfiles.length || profileIds.some((id, index) => id !== discovery.packageModel!.compatibleProfiles[index])) fail(ctx, "BRAND_PACKAGE_PROFILE_MISMATCH", "brand-package.toml compatible_profiles must exactly equal the producer profile inventory.", ".tfsb/brand-package.toml");
    if (discovery.packageModel.consumerProfileDigest !== consumerProfilesDigest) fail(ctx, "BRAND_PACKAGE_PROFILE_DIGEST_MISMATCH", "brand-package.toml consumer_profile_digest must equal the consumer profile domain digest.", ".tfsb/brand-package.toml");
  }

  const hasUnavailableDomain = discovery.domains.some((d) => d.state === "declared-unavailable");
  let brandSystemDigest: Sha256Digest | undefined;
  if (!hasUnavailableDomain) {
    brandSystemDigest = computeBrandSystemDigest({
      brand: discovery.brandModel,
      consumerProfiles: discovery.consumerProfilesModel ?? null,
      exports: discovery.exportsModel ?? null,
      qa: discovery.qaModel ? toBrandQaCanonicalDto(discovery.qaModel) : null,
      recipes: discovery.recipesModel ? toBrandRecipesCanonicalDto(discovery.recipesModel) : null,
      referencedAssets,
      tokens: discovery.tokensModel ? toBrandTokensCanonicalDto(discovery.tokensModel) : null,
    });
  }

  let brandPackageDigest: Sha256Digest | undefined;
  if (discovery.packageModel !== undefined) {
    brandPackageDigest = computeBrandPackageDigest(discovery.packageModel);
  }

  return Object.freeze({
    model: discovery.brandModel,
    ...(discovery.tokensModel === undefined ? {} : { tokensModel: discovery.tokensModel }),
    ...(discovery.recipesModel === undefined ? {} : { recipesModel: discovery.recipesModel }),
    ...(discovery.qaModel === undefined ? {} : { qaModel: discovery.qaModel }),
    ...(discovery.consumerProfilesModel === undefined ? {} : { consumerProfilesModel: discovery.consumerProfilesModel }),
    ...(discovery.packageModel === undefined ? {} : { packageModel: discovery.packageModel }),
    ...(discovery.exportsModel === undefined ? {} : { exportsModel: discovery.exportsModel }),
    brandDigest,
    ...(tokensDigest === undefined ? {} : { tokensDigest }),
    ...(recipesDigest === undefined ? {} : { recipesDigest }),
    ...(qaDigest === undefined ? {} : { qaDigest }),
    ...(consumerProfilesDigest === undefined ? {} : { consumerProfilesDigest }),
    ...(exportsDigest === undefined ? {} : { exportsDigest }),
    ...(rawExportsFileDigest === undefined ? {} : { rawExportsFileDigest }),
    ...(brandSystemDigest === undefined ? {} : { brandSystemDigest }),
    ...(brandPackageDigest === undefined ? {} : { brandPackageDigest }),
    ...(tokenWarnings === undefined ? {} : { tokenWarnings }),
    domains: discovery.domains,
    brandFiles: discovery.brandFiles,
    referencedAssets,
    completeness,
  });
}
