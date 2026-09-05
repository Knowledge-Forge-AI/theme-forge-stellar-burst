import { isDeepStrictEqual } from "node:util";

import { inspectBuild } from "./build.js";
import { optionalLstat, readRegularFileSnapshot } from "./filesystem.js";
import { loadCanonicalProject, verifyLoadedProjectSnapshot } from "./project.js";
import { compareUtf8 } from "./provenance.js";
import { createBuildReceipt } from "./receipt.js";
import { computeAssetSemanticDigest, computeSha256, computeSvgOutputDigest } from "./digests.js";

import { BRAND_FILE_INVENTORY } from "./brand/brand-files.js";

import { inspectDerivedAuthority } from "./brand/derive.js";
import { parseBrandDerivedReceipt } from "./brand/derived-receipt.js";
import { isBrandQaVisualCase } from "./brand/qa-schema.js";
import { runBrandQaProfile } from "./brand/qa-semantic.js";
import { inspectConsumerState, type ConsumerStateInspection } from "./brand/consumer-plan.js";
import { inspectRasterExportState, type RasterStateInspection } from "./brand/export-plan.js";
import { loadRasterCapability } from "./brand/raster-capability.js";

export interface BrandCheckDomain {
  readonly domain: string;
  readonly canonicalPath: string;
  readonly enabled: boolean;
  readonly state: string;
  readonly present: boolean;
}

export interface BrandCheckDerivedStatus {
  readonly total: number;
  readonly unchanged: number;
  readonly stale: number;
  readonly missing: number;
  readonly drifted: number;
  readonly humanOwned: number;
  readonly invalidReceipt: number;
  readonly ownershipConflict: number;
}

export interface BrandCheckResult {
  readonly valid: true;
  readonly completenessSatisfied: boolean;
  readonly brandDigest: string;
  readonly brandSystemDigest?: string;
  readonly tokensDigest?: string;
  readonly recipesDigest?: string;
  readonly qaDigest?: string;
  readonly qa?: BrandCheckQaStatus;
  readonly derived?: BrandCheckDerivedStatus;
  readonly tokenWarnings?: readonly string[];
  readonly domains: readonly BrandCheckDomain[];
  readonly files: readonly {
    readonly canonicalPath: string;
    readonly present: boolean;
    readonly sizeBytes?: number;
  }[];
}

export interface BrandCheckQaStatus {
  readonly profiles: number;
  readonly cases: number;
  readonly semanticPass: number;
  readonly semanticFail: number;
  readonly semanticError: number;
  readonly visualCases: number;
  readonly capabilityRequired: number;
  readonly baselines: { readonly present: number; readonly missing: number; readonly drift: number };
  readonly qaDigest: string;
  readonly resultDigests: readonly string[];
}

export interface CheckResult {
  readonly valid: true;
  readonly sourceChanged: boolean;
  readonly build: {
    readonly missing: readonly string[];
    readonly extra: readonly string[];
    readonly different: readonly string[];
  };
  readonly install: {
    readonly missing: readonly string[];
    readonly different: readonly string[];
  };
  readonly drift: boolean;
  readonly brand?: BrandCheckResult;
  readonly consumer?: ConsumerStateInspection;
  readonly rasterExports?: RasterStateInspection;
}

export async function checkProject(root: string): Promise<CheckResult> {
  const project = await loadCanonicalProject(root, "check");
  const build = await inspectBuild(project, "check");
  const expectedReceipt = createBuildReceipt(project);
  const sourceChanged =
    build.receipt === undefined ||
    !isDeepStrictEqual(build.receipt.canonicalSources, expectedReceipt.canonicalSources);
  const installMissing: string[] = [];
  const installDifferent: string[] = [];
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const inspectDestination = async (destination: string, expected: Uint8Array): Promise<void> => {
    if (await optionalLstat(destination) === undefined) {
      installMissing.push(destination);
      return;
    }
    const actual = await readRegularFileSnapshot(
      destination,
      { operation: "check", domain: "filesystem" },
      "INSTALL_UNSAFE_DESTINATION",
      "Install destination must be one non-symlink regular file.",
    );
    if (!Buffer.from(actual.bytes).equals(Buffer.from(expected))) installDifferent.push(destination);
  };
  for (const install of project.project.installs) {
    const asset = assets.get(install.asset);
    if (asset === undefined) throw new Error("Validated install asset unexpectedly disappeared.");
    const expected = project.outputs.get(asset.filename);
    if (expected === undefined) throw new Error("Validated output unexpectedly disappeared.");
    for (const destination of project.installDestinations.get(install.asset) ?? []) {
      await inspectDestination(destination, expected);
    }
  }
  for (const companion of project.project.companions ?? []) {
    const expected = project.companions.get(companion.file);
    if (expected === undefined) throw new Error("Validated companion unexpectedly disappeared.");
    for (const destination of project.companionDestinations.get(companion.file) ?? []) {
      await inspectDestination(destination, expected);
    }
  }

  let derivedStats: BrandCheckDerivedStatus | undefined;
  let derivedInspection: ReturnType<typeof inspectDerivedAuthority> | undefined;
  let derivedDrift = false;

  if (project.brand !== undefined && project.brand.recipesModel !== undefined) {
    const inspection = inspectDerivedAuthority(project.snapshot.files, { operation: "check", domain: "brand" });
    derivedInspection = inspection;
    const unchanged = inspection.counts.unchanged;
    const stale = inspection.counts["stale-authority"];
    const missing = inspection.counts["missing-target"];
    const drifted = inspection.counts["target-drift"];
    const humanOwned = inspection.counts["human-owned"];
    const invalidReceipt = inspection.counts["invalid-receipt"];
    const ownershipConflict = inspection.counts["ownership-conflict"];
    derivedDrift = inspection.entries.some((entry) => entry.state !== "unchanged");
    derivedStats = {
      total: inspection.entries.length,
      unchanged,
      stale,
      missing,
      drifted,
      humanOwned,
      invalidReceipt,
      ownershipConflict,
    };
  }

  const rasterCapability = await loadRasterCapability();
  let qaStatus: BrandCheckQaStatus | undefined;
  let qaDrift = false;
  if (project.brand?.qaModel !== undefined && project.brand.qaDigest !== undefined && project.brand.brandSystemDigest !== undefined) {
    const canonicalSvgBytes = new Map(project.assets.map((asset) => [asset.id, project.outputs.get(asset.filename)!]));
    const baselineFiles = new Map([...project.snapshot.files].filter(([path]) => path.startsWith(".tfsb/brand-baselines/")).map(([path, file]) => [path, file.bytes]));
    const receipts = new Map();
    for (const [path, file] of project.snapshot.files) if (path.startsWith(".tfsb/derived/") && path.endsWith(".receipt.json")) {
      try {
        const parsed = parseBrandDerivedReceipt(new TextDecoder("utf8", { fatal: true }).decode(file.bytes), path);
        if (parsed.ok) receipts.set(parsed.value.targetAssetId, parsed.value);
      } catch { /* authoritative inspection reports invalid receipts */ }
    }
    let semanticPass = 0, semanticFail = 0, semanticError = 0;
    const resultDigests: string[] = [];
    for (const profile of project.brand.qaModel.profiles) {
      try {
        const result = await runBrandQaProfile({ brand: project.brand.model, qa: project.brand.qaModel, brandSystemDigest: project.brand.brandSystemDigest, assets: new Map(project.assets.map((asset) => [asset.id, asset])), canonicalSvgBytes, completeness: project.brand.completeness, ...(project.brand.tokensModel === undefined ? {} : { tokens: project.brand.tokensModel }), ...(project.brand.recipesModel === undefined ? {} : { recipes: project.brand.recipesModel }), ...(derivedInspection === undefined ? {} : { derived: derivedInspection }), derivedReceipts: receipts, baselineFiles, ...(rasterCapability.available ? { renderer: rasterCapability.qa } : {}) }, profile.id);
        resultDigests.push(result.resultDigest);
        for (const entry of result.results) if (!isBrandQaVisualCase(project.brand.qaModel.cases.find((qaCase) => qaCase.id === entry.caseId)!)) {
          if (entry.status === "pass") semanticPass++;
          else if (entry.status === "fail") semanticFail++;
          else if (entry.status === "error") semanticError++;
        }
      } catch { semanticError++; }
    }
    let baselinePresent = 0, baselineMissing = 0, baselineDrift = 0;
    for (const qaCase of project.brand.qaModel.cases) if (qaCase.kind === "baseline") {
      const file = project.snapshot.files.get(qaCase.baselinePath);
      if (file === undefined) { baselineMissing++; continue; }
      baselinePresent++;
      let targetId = qaCase.asset;
      if (targetId === undefined) {
        const matches = project.brand.model.bindings.filter((binding) => binding.family === qaCase.family && (qaCase.role === undefined || binding.role === qaCase.role) && (qaCase.variant === undefined || binding.variant === qaCase.variant));
        if (matches.length === 1) targetId = matches[0]!.asset;
      }
      const asset = project.assets.find((entry) => entry.id === targetId);
      const svg = asset === undefined ? undefined : project.outputs.get(asset.filename);
      if (file.digest !== qaCase.baselineDigest || asset === undefined || svg === undefined || computeAssetSemanticDigest(asset) !== qaCase.canonicalAssetDigest || computeSvgOutputDigest(Buffer.from(svg).toString("utf8")) !== qaCase.svgDigest) baselineDrift++;
    }
    qaDrift = semanticFail > 0 || semanticError > 0 || baselineMissing > 0 || baselineDrift > 0;
    qaStatus = { profiles: project.brand.qaModel.profiles.length, cases: project.brand.qaModel.cases.length, semanticPass, semanticFail, semanticError, visualCases: project.brand.qaModel.cases.filter(isBrandQaVisualCase).length, capabilityRequired: project.brand.qaModel.profiles.filter((profile) => profile.renderer === "required" && profile.cases.some((id) => isBrandQaVisualCase(project.brand!.qaModel!.cases.find((qaCase) => qaCase.id === id)!))).length, baselines: { present: baselinePresent, missing: baselineMissing, drift: baselineDrift }, qaDigest: project.brand.qaDigest, resultDigests: Object.freeze(resultDigests.sort(compareUtf8)) };
  }

  const consumer = project.consumerLockBytes === undefined ? undefined : await inspectConsumerState({ root: project.root });
  const consumerDrift = consumer !== undefined && consumer.status !== "ok" && consumer.status !== "source-unavailable";
  const rasterExports = project.brand?.exportsModel === undefined ? undefined : await inspectRasterExportState(project.root, rasterCapability);
  const rasterDrift = rasterExports?.drift === true;
  const drift =
    sourceChanged ||
    build.missing.length > 0 ||
    build.extra.length > 0 ||
    build.different.length > 0 ||
    installMissing.length > 0 ||
    installDifferent.length > 0 ||
    derivedDrift ||
    qaDrift ||
    consumerDrift ||
    rasterDrift;
  installMissing.sort(compareUtf8);
  installDifferent.sort(compareUtf8);
  await verifyLoadedProjectSnapshot(project, "check");

  let brand: BrandCheckResult | undefined;
  if (project.brand !== undefined) {
    const fileStatuses = BRAND_FILE_INVENTORY.map((entry) => {
      const snap = project.snapshot.files.get(entry.canonicalPath);
      return {
        canonicalPath: entry.canonicalPath,
        present: snap !== undefined,
        ...(snap === undefined ? {} : { sizeBytes: snap.bytes.byteLength }),
      };
    }).sort((a, b) => compareUtf8(a.canonicalPath, b.canonicalPath));

    brand = {
      valid: true,
      completenessSatisfied: project.brand.completeness.satisfied,
      brandDigest: project.brand.brandDigest,
      ...(project.brand.brandSystemDigest === undefined ? {} : { brandSystemDigest: project.brand.brandSystemDigest }),
      ...(project.brand.tokensDigest === undefined ? {} : { tokensDigest: project.brand.tokensDigest }),
      ...(project.brand.recipesDigest === undefined ? {} : { recipesDigest: project.brand.recipesDigest }),
      ...(project.brand.qaDigest === undefined ? {} : { qaDigest: project.brand.qaDigest }),
      ...(qaStatus === undefined ? {} : { qa: qaStatus }),
      ...(derivedStats === undefined ? {} : { derived: derivedStats }),
      ...(project.brand.tokenWarnings === undefined ? {} : { tokenWarnings: project.brand.tokenWarnings }),
      domains: [...project.brand.domains].sort((a, b) => compareUtf8(a.domain, b.domain)).map((d) => ({
        domain: d.domain,
        canonicalPath: d.canonicalPath,
        enabled: d.enabled,
        state: d.state,
        present: d.present,
      })),
      files: fileStatuses,
    };
  }

  return {
    valid: true,
    sourceChanged,
    build: { missing: build.missing, extra: build.extra, different: build.different },
    install: { missing: installMissing, different: installDifferent },
    drift,
    ...(brand === undefined ? {} : { brand }),
    ...(consumer === undefined ? {} : { consumer }),
    ...(rasterExports === undefined ? {} : { rasterExports }),
  };
}
