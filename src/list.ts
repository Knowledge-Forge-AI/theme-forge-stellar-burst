import { join } from "node:path";

import { loadCanonicalProject, verifyLoadedProjectSnapshot } from "./project.js";
import { compareUtf8 } from "./provenance.js";
import { inspectDerivedAuthority, type DerivedAuthorityState } from "./brand/derive.js";
import { inspectConsumerState, type ConsumerStateInspection } from "./brand/consumer-plan.js";
import { inspectRasterExportState, type RasterStateInspection } from "./brand/export-plan.js";

export interface AssetInventoryItem {
  readonly id: string;
  readonly filename: string;
  readonly buildPath: string;
  readonly destinations: readonly string[];
  readonly authority?: "source" | "derived";
  readonly recipeId?: string;
  readonly derivedState?: DerivedAuthorityState;
  readonly receiptDigest?: string;
  readonly targetModelDigest?: string;
  readonly targetSvgDigest?: string;
}

export interface CompanionInventoryItem {
  readonly file: string;
  readonly canonicalPath: string;
  readonly destinations: readonly string[];
}

export interface BrandListInventoryFamily {
  readonly id: string;
  readonly name: string;
  readonly requiredRoles: readonly string[];
  readonly optionalRoles: readonly string[];
}

export interface BrandListInventoryVariant {
  readonly family: string;
  readonly id: string;
  readonly backgrounds: readonly string[];
  readonly colorMode: string;
  readonly scale: string;
  readonly status: string;
  readonly minimumWidthPx?: number;
  readonly minimumHeightPx?: number;
  readonly displayOrder?: number;
}

export interface BrandListInventoryBinding {
  readonly family: string;
  readonly role: string;
  readonly variant: string;
  readonly asset: string;
  readonly authority: string;
}

export interface BrandListInventoryDomain {
  readonly domain: string;
  readonly state: string;
  readonly present: boolean;
}

export interface BrandListInventory {
  readonly schemaVersion: number;
  readonly brandDigest: string;
  readonly brandSystemDigest?: string;
  readonly tokensDigest?: string;
  readonly recipesDigest?: string;
  readonly domains: readonly BrandListInventoryDomain[];
  readonly families: readonly BrandListInventoryFamily[];
  readonly variants: readonly BrandListInventoryVariant[];
  readonly bindings: readonly BrandListInventoryBinding[];
  readonly completeness: {
    readonly satisfied: boolean;
    readonly familyCount: number;
    readonly variantCount: number;
    readonly bindingCount: number;
    readonly requirementCount: number;
  };
}

export interface ProjectInventory {
  readonly assets: readonly AssetInventoryItem[];
  readonly companions: readonly CompanionInventoryItem[];
  readonly brand?: BrandListInventory;
  readonly consumer?: ConsumerStateInspection;
  readonly rasterExports?: RasterStateInspection;
}

export async function listProject(root: string): Promise<ProjectInventory> {
  const project = await loadCanonicalProject(root, "list");

  const recipeTargetMap = new Map<string, string>();
  const derivedAuthority = new Map<string, ReturnType<typeof inspectDerivedAuthority>["entries"][number]>();
  if (project.brand !== undefined && project.brand.recipesModel !== undefined) {
    for (const r of project.brand.recipesModel.recipes) {
      recipeTargetMap.set(r.target_asset, r.id);
    }
    for (const entry of inspectDerivedAuthority(project.snapshot.files, { operation: "list", domain: "brand" }).entries) {
      derivedAuthority.set(entry.targetAssetId, entry);
    }
  }

  const assets = [...project.assets].sort((left, right) => compareUtf8(left.id, right.id)).map((asset) => {
    const isDerived = recipeTargetMap.has(asset.id);
    return {
      id: asset.id,
      filename: asset.filename,
      buildPath: join(project.project.buildDirectory, asset.filename).replaceAll("\\", "/"),
      destinations: project.project.installs.find((install) => install.asset === asset.id)?.destinations ?? [],
      ...(project.brand === undefined
        ? {}
        : isDerived
        ? {
            authority: "derived" as const,
            recipeId: recipeTargetMap.get(asset.id)!,
            ...(derivedAuthority.get(asset.id) === undefined ? {} : {
              derivedState: derivedAuthority.get(asset.id)!.state,
              ...(derivedAuthority.get(asset.id)!.receiptDigest === undefined ? {} : { receiptDigest: derivedAuthority.get(asset.id)!.receiptDigest }),
              ...(derivedAuthority.get(asset.id)!.targetModelDigest === undefined ? {} : { targetModelDigest: derivedAuthority.get(asset.id)!.targetModelDigest }),
              ...(derivedAuthority.get(asset.id)!.targetSvgDigest === undefined ? {} : { targetSvgDigest: derivedAuthority.get(asset.id)!.targetSvgDigest }),
            }),
          }
        : { authority: "source" as const }),
    };
  });
  const declarations = new Map<string, readonly string[]>(project.project.companions.map((companion) => [companion.file, companion.destinations]));
  const companions = [...project.companions.keys()].sort(compareUtf8).map((file) => ({
    file,
    canonicalPath: `.tfsb/companions/${file}`,
    destinations: declarations.get(file) ?? [],
  }));

  let brand: BrandListInventory | undefined;
  if (project.brand !== undefined) {
    brand = {
      schemaVersion: project.brand.model.schemaVersion,
      brandDigest: project.brand.brandDigest,
      ...(project.brand.brandSystemDigest === undefined ? {} : { brandSystemDigest: project.brand.brandSystemDigest }),
      ...(project.brand.tokensDigest === undefined ? {} : { tokensDigest: project.brand.tokensDigest }),
      ...(project.brand.recipesDigest === undefined ? {} : { recipesDigest: project.brand.recipesDigest }),
      domains: [...project.brand.domains].sort((a, b) => compareUtf8(a.domain, b.domain)).map((d) => ({
        domain: d.domain,
        state: d.state,
        present: d.present,
      })),
      families: [...project.brand.model.families].sort((a, b) => compareUtf8(a.id, b.id)).map((f) => ({
        id: f.id,
        name: f.name,
        requiredRoles: [...f.requiredRoles].sort(compareUtf8),
        optionalRoles: [...f.optionalRoles].sort(compareUtf8),
      })),
      variants: [...project.brand.model.variants].sort((a, b) => compareUtf8(a.family, b.family) || compareUtf8(a.id, b.id)).map((v) => ({
        family: v.family,
        id: v.id,
        backgrounds: [...v.backgrounds].sort(compareUtf8),
        colorMode: v.colorMode,
        scale: v.scale,
        status: v.status,
        ...(v.minimumWidthPx === undefined ? {} : { minimumWidthPx: v.minimumWidthPx }),
        ...(v.minimumHeightPx === undefined ? {} : { minimumHeightPx: v.minimumHeightPx }),
        ...(v.displayOrder === undefined ? {} : { displayOrder: v.displayOrder }),
      })),
      bindings: [...project.brand.model.bindings].sort((a, b) => compareUtf8(a.family, b.family) || compareUtf8(a.role, b.role) || compareUtf8(a.variant, b.variant)).map((b) => ({
        family: b.family,
        role: b.role,
        variant: b.variant,
        asset: b.asset,
        authority: b.authority,
      })),
      completeness: project.brand.completeness,
    };
  }

  await verifyLoadedProjectSnapshot(project, "list");
  const consumer = project.consumerLockBytes === undefined ? undefined : await inspectConsumerState({ root: project.root });
  const rasterExports = project.brand?.exportsModel === undefined ? undefined : await inspectRasterExportState(project.root);
  return { assets, companions, ...(brand === undefined ? {} : { brand }), ...(consumer === undefined ? {} : { consumer }), ...(rasterExports === undefined ? {} : { rasterExports }) };
}
