import { computeSha256, type Sha256Digest } from "../digests.js";
import { DiagnosticError } from "../diagnostics.js";
import { verifyLoadedProjectSnapshot, type LoadedProject } from "../project.js";
import { compareUtf8 } from "../provenance.js";
import { compareBrandSnapshots, createLoadedProjectBrandDiffSnapshot } from "../brand/brand-diff.js";
import {
  disposeBrandDerivationPlan, executeBrandDerivationPlan, inspectBrandDerivationPlanRetention,
  inspectDerivedAuthority, planBrandDerivation, type BrandDerivePlan,
} from "../brand/derive.js";
import { buildRecipeGraph } from "../brand/recipes.js";
import { runLoadedBrandQaProfile } from "../brand/qa-semantic.js";
import { isBrandQaVisualCase, type BrandQaCase } from "../brand/qa-schema.js";
import {
  disposeBrandQaBaselineUpdatePlan, executeBrandQaBaselineUpdatePlan,
  inspectBrandQaBaselineProtocol, inspectBrandQaBaselineUpdatePlanRetention, planBrandQaBaselineUpdate,
  type BrandQaBaselineUpdatePlan,
} from "../brand/qa-baseline.js";
import {
  disposeConsumerPlan, inspectConsumerPlanRetention, inspectConsumerState,
  inspectConsumerStateWithVerifiedSources, planConsumerInstallWithVerifiedSources,
  planConsumerSyncWithVerifiedSources, type ConsumerPlanSummary,
} from "../brand/consumer-plan.js";
import { executeConsumerInstallPlan, executeConsumerSyncPlan, type ConsumerTransactionHooks } from "../brand/consumer-install.js";
import {
  disposeConsumerSources, getVerifiedConsumerBrandDiffSnapshot, revalidateConsumerSources,
  type VerifiedConsumerSources,
} from "../brand/consumer-source.js";
import {
  disposeRasterExportPlan, executeRasterExportPlan, inspectRasterExportPlanRetention,
  inspectRasterExportState, planRasterExport, type RasterExportPlan, type RasterTransactionHooks,
} from "../brand/export-plan.js";
import type { RasterCapabilityStatus } from "../brand/raster-capability.js";
import { canonicalJson, type PlanDigestEnvelope } from "./canonical-json.js";
import type { CursorScope } from "./cursor.js";
import { ProtocolError } from "./errors.js";
import type { PlanBindings } from "./plan-registry.js";
import { isQualifiedStudioRasterCapability } from "./v1-registry.js";
import { executeBrandVisualEvidence } from "./brand-visual-methods.js";
import type { ApplyLifecycle, MutationProgress, PlanAuthority } from "./mutation-methods.js";
import type { StudioSession } from "./session.js";
import type {
  BrandConsumerPlanParams, BrandConsumerProfileItem, BrandConsumerProfileListParams,
  BrandConsumerSourcesParams, BrandDerivePlanParams, BrandDiffParams, BrandExportPlanParams,
  BrandFamilyItem, BrandPage, BrandPageParams, BrandProjectParams, BrandQaBaselinePlanParams,
  BrandQaProfileParams, BrandRecipeGraphResult, BrandStatusResult, BrandTokenItem,
  ProjectHandle, StudioBrandPlanMethod, StudioBrandReadMethodLatest, StudioPlanSummary,
  BrandDerivePlanSummary, BrandQaBaselinePlanSummary, BrandRasterExportPlanSummary,
  BrandQaProfileListItem, BrandQaProfileListParams, BrandVisualEvidenceParams,
} from "./v1-types.js";

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new ProtocolError("REQUEST_CANCELLED");
}

function digest(value: unknown): Sha256Digest {
  return computeSha256(Buffer.from(canonicalJson(value as never), "utf8"));
}

function frozenRaster(session: StudioSession): RasterCapabilityStatus {
  return isQualifiedStudioRasterCapability(session.rasterCapability)
    ? session.rasterCapability
    : Object.freeze({ available: false, code: "EXPORT_CAPABILITY_UNAVAILABLE", reason: "The session has no qualified raster capability." });
}

function requireBrand(project: LoadedProject): NonNullable<LoadedProject["brand"]> {
  if (project.brand === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  return project.brand;
}

async function loadedProject(session: StudioSession, handle: ProjectHandle): Promise<{ readonly loaded: LoadedProject; readonly root: string; readonly digest: string }> {
  const project = await session.handles.project(handle);
  return { loaded: project.loaded, root: project.record.root, digest: project.digest };
}

function roleCount(brand: NonNullable<LoadedProject["brand"]>): number {
  return new Set([...brand.model.families.flatMap((item) => [...item.requiredRoles, ...item.optionalRoles]), ...brand.model.bindings.map((item) => item.role)]).size;
}

function resolvedQaTargets(project: LoadedProject, qaCase: BrandQaCase): number {
  const brand = requireBrand(project);
  if (qaCase.kind === "inventory") return 1;
  if (qaCase.kind === "recipe") {
    const recipes = brand.recipesModel?.recipes ?? [];
    return qaCase.recipe === undefined
      ? recipes.filter((recipe) => brand.model.bindings.some((binding) => binding.family === qaCase.family && (binding.asset === recipe.source_asset || binding.asset === recipe.target_asset))).length
      : recipes.filter((recipe) => recipe.id === qaCase.recipe).length;
  }
  if (qaCase.asset !== undefined) return project.assets.some((asset) => asset.id === qaCase.asset) ? 1 : 0;
  return brand.model.bindings.filter((binding) => binding.family === qaCase.family && (qaCase.role === undefined || binding.role === qaCase.role) && (qaCase.variant === undefined || binding.variant === qaCase.variant)).length;
}

function tokenItems(project: LoadedProject): readonly BrandTokenItem[] {
  const brand = requireBrand(project);
  if (brand.tokensModel === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  const tokens = [...brand.tokensModel.colors, ...brand.tokensModel.gradients, ...brand.tokensModel.dimensions, ...brand.tokensModel.opacities];
  return Object.freeze(tokens.map((token) => {
    const referenceCount = brand.tokensModel!.gradients.reduce((count, gradient) => count + gradient.stops.filter((stop) => stop.colorToken === token.id).length, 0);
    const recipeUseCount = brand.recipesModel?.recipes.reduce((count, recipe) => count + recipe.operations.filter((operation) => "replacement_token" in operation && operation.replacement_token === token.id || "color_token" in operation && operation.color_token === token.id).length, 0) ?? 0;
    return Object.freeze({ ...token, referenceCount, recipeUseCount, unused: referenceCount + recipeUseCount === 0 });
  }).sort((a, b) => compareUtf8(a.id, b.id)));
}

function page<T>(session: StudioSession, method: CursorScope["method"], projectHandle: ProjectHandle, pageSize: number, cursor: string | undefined, viewDigest: Sha256Digest, items: readonly T[], key: (item: T) => string): BrandPage<T> {
  const scope: CursorScope = { method: method as Extract<CursorScope, { readonly kind: "project" }>["method"], kind: "project", handle: projectHandle } as CursorScope;
  const protocolVersion = session.negotiatedVersion;
  if (protocolVersion !== "1.1" && protocolVersion !== "1.2") throw new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE");
  const decoded = cursor === undefined ? undefined : session.cursors.decode(cursor, scope, pageSize, protocolVersion);
  if (decoded !== undefined && decoded.viewDigest !== viewDigest) throw new ProtocolError("CURSOR_STALE");
  if (decoded?.lastKey.kind !== undefined && decoded.lastKey.kind !== "brand") throw new ProtocolError("CURSOR_INVALID");
  const start = decoded === undefined ? 0 : items.findIndex((item) => key(item) === decoded.lastKey.id) + 1;
  if (decoded !== undefined && start === 0) throw new ProtocolError("CURSOR_INVALID");
  const selected = items.slice(start, start + pageSize);
  const hasMore = start + selected.length < items.length;
  return Object.freeze({
    page: Object.freeze({
      size: pageSize, count: selected.length, items: Object.freeze(selected),
      nextCursor: hasMore ? session.cursors.encode({ protocolVersion, scope, viewDigest, lastKey: { projectId: "project", kind: "brand", id: key(selected.at(-1)!) }, pageSize }) : null,
    }),
    viewDigest,
  });
}

function capabilityResult(session: StudioSession): unknown {
  if (!isQualifiedStudioRasterCapability(session.rasterCapability)) return Object.freeze({ available: false });
  const value = session.rasterCapability.adapter.descriptor;
  return Object.freeze({ available: true, adapterId: value.adapterId, rendererPackage: value.rendererPackage, rendererVersion: value.rendererVersion, rendererBuildDigest: value.rendererBuildDigest, nodeMajor: value.nodeMajor, platformClaim: value.platformClaim, qualificationId: value.qualificationId });
}

function familyItems(project: LoadedProject): readonly BrandFamilyItem[] {
  const brand = requireBrand(project);
  const derived = brand.recipesModel === undefined ? undefined : inspectDerivedAuthority(project.snapshot.files, { operation: "list", domain: "brand" });
  const stateByTarget = new Map(derived?.entries.map((entry) => [entry.targetAssetId, entry.state]));
  return Object.freeze(brand.model.families.map((family) => {
    const variants = brand.model.variants.filter((item) => item.family === family.id).sort((a, b) => compareUtf8(a.id, b.id));
    const bindings = brand.model.bindings.filter((item) => item.family === family.id).map((item) => Object.freeze({ ...item, ...(stateByTarget.get(item.asset) === undefined ? {} : { derivedState: stateByTarget.get(item.asset)! }) })).sort((a, b) => compareUtf8(`${a.role}/${a.variant}/${a.asset}`, `${b.role}/${b.variant}/${b.asset}`));
    const requirements = (brand.model.requirements ?? []).filter((item) => item.family === family.id).sort((a, b) => compareUtf8(`${a.role}/${a.background ?? ""}/${a.colorMode ?? ""}/${a.scale ?? ""}`, `${b.role}/${b.background ?? ""}/${b.colorMode ?? ""}/${b.scale ?? ""}`));
    const complete = family.requiredRoles.every((role) => bindings.some((binding) => binding.role === role));
    return Object.freeze({ ...family, variants: Object.freeze(variants), bindings: Object.freeze(bindings), requirements: Object.freeze(requirements), complete });
  }).sort((a, b) => compareUtf8(a.id, b.id)));
}

function depthFor(id: string, dependencies: ReadonlyMap<string, readonly string[]>, memo: Map<string, number>): number {
  const present = memo.get(id); if (present !== undefined) return present;
  const value = 1 + Math.max(0, ...(dependencies.get(id) ?? []).map((entry) => depthFor(entry, dependencies, memo)));
  memo.set(id, value); return value;
}

function consumerHooks(lifecycle: ApplyLifecycle): ConsumerTransactionHooks {
  const hooks = lifecycle.transactionHooks(); let promoted = false;
  const beforePromotion = async (): Promise<void> => { if (promoted) return; promoted = true; await hooks.beforeFirstRename?.(); };
  return {
    beforeStage: async () => { await hooks.beforeStageCreate?.(); await hooks.beforeStageWrite?.(); },
    afterStage: async () => { await hooks.afterStageWrite?.(); },
    beforeOutputPromotion: beforePromotion, beforeLockPromotion: beforePromotion,
    beforeRollback: async () => { await hooks.beforeRollback?.(); },
    beforeCleanup: async () => { await hooks.beforeBackupCleanup?.(); },
  };
}

function rasterHooks(lifecycle: ApplyLifecycle): RasterTransactionHooks {
  const hooks = lifecycle.transactionHooks(); let promoted = false;
  return { onEvent: async (event) => {
    if (event === "after-stage") await hooks.afterStageWrite?.();
    if ((event === "before-output-promotion" || event === "before-receipt-promotion") && !promoted) { promoted = true; await hooks.beforeFirstRename?.(); }
    if (event === "before-rollback") await hooks.beforeRollback?.();
    if (event === "before-cleanup") await hooks.beforeBackupCleanup?.();
  } };
}

export function brandReadLane(session: StudioSession, method: StudioBrandReadMethodLatest, params: unknown): string {
  const value = params as BrandProjectParams;
  if (method === "brand.qa.result.get" || method === "brand.visual.evidence.get") return "brand:raster-read";
  return session.handles.laneFor("project", value.projectHandle);
}

export async function executeBrandRead(session: StudioSession, method: StudioBrandReadMethodLatest, params: unknown, signal: AbortSignal): Promise<unknown> {
  if (session.negotiatedVersion !== "1.1" && session.negotiatedVersion !== "1.2") throw new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE");
  check(signal);
  try {
    const base = params as BrandProjectParams;
    const project = await loadedProject(session, base.projectHandle);
    const raster = frozenRaster(session);
    let result: unknown;
    if (method === "brand.visual.evidence.get") {
      result = await executeBrandVisualEvidence(session, project.loaded, project.digest as Sha256Digest, params as BrandVisualEvidenceParams, signal);
    } else if (method === "brand.status") {
      const brand = project.loaded.brand;
      if (brand === undefined) result = Object.freeze({ present: false, raster: Object.freeze({ available: raster.available }) } satisfies BrandStatusResult);
      else {
        const derived = brand.recipesModel === undefined
          ? Object.freeze({ unchanged: 0, "stale-authority": 0, "missing-target": 0, "human-owned": 0, "target-drift": 0, "invalid-receipt": 0, "ownership-conflict": 0 })
          : inspectDerivedAuthority(project.loaded.snapshot.files, { operation: "list", domain: "brand" }).counts;
        const tokenCount = (brand.tokensModel?.colors.length ?? 0) + (brand.tokensModel?.gradients.length ?? 0) + (brand.tokensModel?.dimensions.length ?? 0) + (brand.tokensModel?.opacities.length ?? 0);
        const domainDigest = (domain: string): Sha256Digest | null => domain === "brand" ? brand.brandDigest : domain === "tokens" ? brand.tokensDigest ?? null : domain === "recipes" ? brand.recipesDigest ?? null : domain === "qa" ? brand.qaDigest ?? null : domain === "consumer_profiles" ? brand.consumerProfilesDigest ?? null : domain === "exports" ? brand.exportsDigest ?? null : domain === "package" ? brand.brandPackageDigest ?? null : null;
        const exports = brand.exportsModel?.profiles.flatMap((profile) => profile.outputs) ?? [];
        const consumer = await inspectConsumerState({ root: project.root });
        const qaBaselines = brand.qaModel?.cases.filter((qaCase) => qaCase.kind === "baseline").length ?? 0;
        result = Object.freeze({ present: true, schemaVersion: 1, brandDigest: brand.brandDigest, brandSystemDigest: brand.brandSystemDigest ?? null, domains: Object.freeze([{ domain: "brand", state: "available", digest: brand.brandDigest }, ...brand.domains.map((item) => ({ domain: item.domain, state: item.state, digest: domainDigest(item.domain) }))].sort((a, b) => compareUtf8(a.domain, b.domain))), counts: Object.freeze({ families: brand.model.families.length, roles: roleCount(brand), variants: brand.model.variants.length, bindings: brand.model.bindings.length, requirements: brand.model.requirements?.length ?? 0, tokens: tokenCount, recipes: brand.recipesModel?.recipes.length ?? 0, qaProfiles: brand.qaModel?.profiles.length ?? 0, qaCases: brand.qaModel?.cases.length ?? 0, qaBaselines, consumerProfiles: brand.consumerProfilesModel?.profiles.length ?? 0, exportProfiles: brand.exportsModel?.profiles.length ?? 0 }), completeness: brand.completeness, derived, consumerLock: Object.freeze({ present: project.loaded.consumerLockBytes !== undefined, status: consumer.status, packages: consumer.packages.length, profiles: consumer.packages.reduce((count, item) => count + item.profiles.length, 0), mappings: consumer.mappings.length }), export: Object.freeze({ outputs: exports.length, receipts: [...project.loaded.snapshot.files.keys()].filter((path) => path.startsWith(".tfsb/raster-receipts/") && path.endsWith(".receipt.json")).length }), raster: Object.freeze({ available: raster.available }) } satisfies BrandStatusResult);
      }
    } else if (method === "brand.family.list") {
      const value = params as BrandPageParams; const items = familyItems(project.loaded); const view = digest({ project: project.digest, brand: requireBrand(project.loaded).brandSystemDigest ?? requireBrand(project.loaded).brandDigest, items }); result = page(session, method, value.projectHandle, value.pageSize, value.cursor, view, items, (item) => item.id);
    } else if (method === "brand.token.list") {
      const value = params as BrandPageParams; const items = tokenItems(project.loaded); const view = digest({ project: project.digest, tokens: requireBrand(project.loaded).tokensDigest, items }); result = page(session, method, value.projectHandle, value.pageSize, value.cursor, view, items, (item) => item.id);
    } else if (method === "brand.recipe.graph") {
      const brand = requireBrand(project.loaded); if (brand.recipesModel === undefined || brand.recipesDigest === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
      const graph = buildRecipeGraph(brand.recipesModel, { operation: "list", domain: "brand" }); const derived = inspectDerivedAuthority(project.loaded.snapshot.files, { operation: "list", domain: "brand" }); const states = new Map(derived.entries.map((entry) => [entry.targetAssetId, entry])); const deps = new Map([...graph.nodes].map(([id, node]) => [id, node.dependencies])); const memo = new Map<string, number>();
      const nodes = graph.topologicalOrder.map((recipe) => { const node = graph.nodes.get(recipe.id)!; const state = states.get(recipe.target_asset); const operations = recipe.operations.map((operation) => operation.operation); return Object.freeze({ recipeId: recipe.id, sourceAsset: recipe.source_asset, targetAsset: recipe.target_asset, dependencies: node.dependencies, dependents: node.dependents, operations: Object.freeze(operations), operationDigest: digest(recipe.operations), depth: depthFor(recipe.id, deps, memo), targetState: state?.state ?? "missing", receiptDigest: state?.receiptDigest ?? null }); });
      result = Object.freeze({ recipeDigest: brand.recipesDigest, graphDigest: digest(nodes), nodes: Object.freeze(nodes), affectedTargetCount: new Set(nodes.map((node) => node.targetAsset)).size, ownershipConflicts: derived.entries.filter((entry) => !["current", "missing-target"].includes(entry.state)).length } satisfies BrandRecipeGraphResult);
    } else if (method === "brand.qa.profile.list") {
      if (session.negotiatedVersion !== "1.2") throw new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE");
      const value = params as BrandQaProfileListParams; const brand = requireBrand(project.loaded); const qa = brand.qaModel;
      if (qa === undefined || brand.qaDigest === undefined || brand.brandSystemDigest === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
      const items: BrandQaProfileListItem[] = qa.profiles.map((profile) => {
        const cases = profile.cases.map((caseId) => qa.cases.find((entry) => entry.id === caseId));
        if (cases.some((entry) => entry === undefined)) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
        const visualCaseCount = cases.filter((entry) => entry !== undefined && isBrandQaVisualCase(entry)).length;
        return Object.freeze({ id: profile.id, renderer: profile.renderer, formats: Object.freeze([...profile.formats]), caseCount: cases.length, semanticCaseCount: cases.length - visualCaseCount, visualCaseCount, baselineCaseCount: cases.filter((entry) => entry?.kind === "baseline").length, qaDigest: brand.qaDigest!, brandSystemDigest: brand.brandSystemDigest! });
      }).sort((left, right) => compareUtf8(left.id, right.id));
      const view = digest({ project: project.digest, qa: brand.qaDigest, brand: brand.brandSystemDigest, items });
      result = page(session, method, value.projectHandle, value.pageSize, value.cursor, view, items, (item) => item.id);
    } else if (method === "brand.qa.profile.get") {
      const value = params as BrandQaProfileParams; const brand = requireBrand(project.loaded); const qa = brand.qaModel; if (qa === undefined || brand.qaDigest === undefined || brand.brandSystemDigest === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED"); const profile = qa.profiles.find((item) => item.id === value.profileId); if (profile === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED"); const cases = profile.cases.map((id) => qa.cases.find((item) => item.id === id)!).sort((a, b) => compareUtf8(a.id, b.id)); const visual = cases.filter(isBrandQaVisualCase); const targetCounts = new Map(cases.map((item) => [item.id, resolvedQaTargets(project.loaded, item)])); const resolvedTargetCount = cases.reduce((count, item) => count + targetCounts.get(item.id)!, 0); const evaluationCount = cases.reduce((count, item) => count + targetCounts.get(item.id)! * (isBrandQaVisualCase(item) ? item.sizes.length * item.backgrounds.length : 1), 0);
      if (session.negotiatedVersion === "1.2") {
        const publicCases = cases.map((item) => { if (item.kind !== "baseline") return item; const { baselinePath: _baselinePath, ...publicCase } = item; return Object.freeze(publicCase); });
        const baselines = visual.flatMap((item) => item.kind === "baseline" ? [{ caseId: item.id, digest: project.loaded.snapshot.files.get(item.baselinePath)?.digest ?? null }] : []);
        result = Object.freeze({ profile, cases: Object.freeze(publicCases), resolvedTargetCount, evaluationCount, qaDigest: brand.qaDigest, brandSystemDigest: brand.brandSystemDigest, baselines: Object.freeze(baselines), raster: Object.freeze({ available: raster.available }) });
      } else {
        const baselines = visual.flatMap((item) => item.kind === "baseline" ? [{ identity: item.baselinePath, digest: project.loaded.snapshot.files.get(item.baselinePath)?.digest ?? null }] : []);
        result = Object.freeze({ profile, cases: Object.freeze(cases), resolvedTargetCount, evaluationCount, qaDigest: brand.qaDigest, brandSystemDigest: brand.brandSystemDigest, baselines: Object.freeze(baselines), raster: Object.freeze({ available: raster.available }) });
      }
    } else if (method === "brand.qa.result.get") {
      const value = params as BrandQaProfileParams; const renderer = raster.available ? Object.freeze({ ...raster.qa, renderSvg: async (input: Parameters<typeof raster.qa.renderSvg>[0]) => { check(signal); const rendered = await raster.qa.renderSvg(input); check(signal); return rendered; }, decodePng: async (input: Parameters<typeof raster.qa.decodePng>[0]) => { check(signal); const decoded = await raster.qa.decodePng(input); check(signal); return decoded; } }) : undefined; result = await runLoadedBrandQaProfile(project.loaded, value.profileId, renderer);
    } else if (method === "brand.diff") {
      const value = params as BrandDiffParams; const sources = await session.handles.leaseBrandSources([value.sourceHandle]); try { await revalidateConsumerSources(sources); const source = sources.packages[0]!; const before = getVerifiedConsumerBrandDiffSnapshot(sources, source.packageId); const after = createLoadedProjectBrandDiffSnapshot(project.loaded); await verifyLoadedProjectSnapshot(project.loaded, "diff"); await revalidateConsumerSources(sources); result = Object.freeze({ diff: compareBrandSnapshots(before, after), beforeBindingDigest: session.handles.bindingDigest(value.sourceHandle), afterBindingDigest: session.handles.bindingDigest(value.projectHandle), visualDiff: Object.freeze({ available: raster.available }) }); } finally { await disposeConsumerSources(sources); }
    } else if (method === "brand.consumer.profile.list") {
      const value = params as BrandConsumerProfileListParams; let sources: VerifiedConsumerSources | undefined; try { if ((value.sourceHandles?.length ?? 0) > 0) sources = await session.handles.leaseBrandSources(value.sourceHandles!); const items: BrandConsumerProfileItem[] = []; const seen = new Set<string>(); const add = (item: BrandConsumerProfileItem): void => { if (seen.has(item.qualifiedProfileId)) throw new ProtocolError("DOMAIN_OPERATION_FAILED"); seen.add(item.qualifiedProfileId); items.push(Object.freeze(item)); }; for (const pkg of sources?.packages ?? []) for (const profile of pkg.consumerProfiles?.profiles ?? []) add({ qualifiedProfileId: profile.qualifiedId, authorityKind: "producer-package", packageId: pkg.packageId, profile, outputRuleCount: profile.outputs.length, resolvedOutputCount: pkg.assetIds.length + pkg.companionIds.length }); const brand = project.loaded.brand; if (brand !== undefined) for (const profile of brand.consumerProfilesModel?.profiles ?? []) add({ qualifiedProfileId: profile.qualifiedId, authorityKind: "producer-project", packageId: brand.packageModel?.packageId ?? "project", profile, outputRuleCount: profile.outputs.length, resolvedOutputCount: profile.outputs.length }); for (const profile of project.loaded.localConsumerProfiles?.profiles ?? []) add({ qualifiedProfileId: profile.qualifiedId, authorityKind: "consumer-local", packageId: profile.compatiblePackage, profile, outputRuleCount: profile.outputs.length, resolvedOutputCount: null }); items.sort((a, b) => compareUtf8(a.qualifiedProfileId, b.qualifiedProfileId)); const view = digest({ project: project.digest, sources: sources?.packages.map((item) => item.source) ?? [], profiles: items }); result = page(session, method, value.projectHandle, value.pageSize, value.cursor, view, items, (item) => item.qualifiedProfileId); } finally { if (sources !== undefined) await disposeConsumerSources(sources); }
    } else if (method === "brand.consumer.lock.status") {
      const value = params as BrandConsumerSourcesParams; let sources: VerifiedConsumerSources | undefined; try { if ((value.sourceHandles?.length ?? 0) > 0) sources = await session.handles.leaseBrandSources(value.sourceHandles!); result = sources === undefined ? await inspectConsumerState({ root: project.root }) : await inspectConsumerStateWithVerifiedSources(project.root, sources); } finally { if (sources !== undefined) await disposeConsumerSources(sources); }
    } else if (method === "brand.export.capability") result = capabilityResult(session);
    else {
      const value = params as BrandPageParams; const inspection = await inspectRasterExportState(project.root, raster); const items = inspection.entries.map((item) => Object.freeze({ profileId: item.profileId, outputId: item.outputId, assetId: item.assetId ?? null, binding: item.binding ?? null, destination: item.destination, state: item.state, width: item.width ?? null, height: item.height ?? null, purpose: item.purpose ?? null, background: item.background ?? null, alpha: item.alpha ?? null, canonicalAssetDigest: item.canonicalAssetDigest ?? null, svgDigest: item.svgDigest ?? null, profileDigest: item.profileDigest ?? null, outputConfigDigest: item.outputConfigDigest ?? null, pngDigest: item.pngDigest ?? null, decodedPixelDigest: item.decodedPixelDigest ?? null, receiptDigest: item.receiptDigest ?? null, capabilityAvailable: raster.available })).sort((a, b) => compareUtf8(`${a.profileId}/${a.outputId}`, `${b.profileId}/${b.outputId}`)); const view = digest({ project: project.digest, capability: raster.available, items }); result = page(session, method, value.projectHandle, value.pageSize, value.cursor, view, items, (item) => `${item.profileId}/${item.outputId}`);
    }
    check(signal); await verifyLoadedProjectSnapshot(project.loaded, "list"); return result;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    if (error instanceof DiagnosticError) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  }
}

function bindings(session: StudioSession, method: StudioBrandPlanMethod, projectHandle: ProjectHandle, sourceHandles: readonly string[] = []): PlanBindings {
  return { sessionNonce: session.nonce, method, root: session.handles.bindingDigest(projectHandle), ...(sourceHandles.length === 0 ? {} : { auxiliary: Object.freeze(sourceHandles.map((handle) => session.handles.bindingDigest(handle))) }) };
}

function envelope(session: StudioSession, method: StudioBrandPlanMethod, authority: unknown, handles: unknown, preState: unknown, summary: StudioPlanSummary): PlanDigestEnvelope {
  const protocolVersion = session.negotiatedVersion ?? "1.1";
  return { authority: authority as never, handles: handles as never, method, preState: preState as never, protocol: "tfsb.studio", protocolVersion, summary: summary as never };
}

export async function createBrandPlanAuthority(session: StudioSession, method: StudioBrandPlanMethod, params: unknown, signal: AbortSignal, progress: MutationProgress): Promise<PlanAuthority<any>> {
  if (session.negotiatedVersion !== "1.1" && session.negotiatedVersion !== "1.2") throw new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE");
  check(signal); progress("snapshot", 0, 1);
  const base = params as BrandProjectParams; const project = await loadedProject(session, base.projectHandle); const raster = frozenRaster(session); progress("snapshot", 1, 1); progress("plan", 0, 1);
  let authority: PlanAuthority<any>;
  if (method === "brand.derive.plan") {
    const value = params as BrandDerivePlanParams; const plan = await planBrandDerivation({ root: project.root, ...(value.selection.kind === "all" ? { all: true } : { recipes: value.selection.recipeIds }) }); const brandSystemDigest = requireBrand(project.loaded).brandSystemDigest; if (brandSystemDigest === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED"); const summary: BrandDerivePlanSummary = Object.freeze({ selectedRecipes: plan.selectedRecipes, transitiveRecipes: plan.transitiveRecipes, affectedTargets: plan.affectedTargets, createdCount: plan.createdCount, updatedCount: plan.updatedCount, unchangedCount: plan.unchangedCount, operationSummaries: plan.operationSummaries, targetStates: plan.targetStates, tokenDigest: plan.tokenDigest, recipeDigest: plan.recipeDigest, brandSystemDigest, warnings: plan.warnings, dryRun: plan.dryRun }); const planBindings = bindings(session, method, value.projectHandle); authority = { plan, summary, envelope: envelope(session, method, { selection: value.selection }, { project: planBindings.root }, { project: project.digest }, summary), bindings: planBindings, retention: inspectBrandDerivationPlanRetention(plan), dispose: disposeBrandDerivationPlan, revalidate: async (applySignal) => { await session.handles.revalidateProject(value.projectHandle, "existing"); check(applySignal); }, execute: async (authentic: BrandDerivePlan, lifecycle) => executeBrandDerivationPlan(authentic, lifecycle.transactionHooks()), mutates: true };
  } else if (method === "brand.qa.baseline.plan") {
    if (!raster.available) throw new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE"); const value = params as BrandQaBaselinePlanParams; const plan = await planBrandQaBaselineUpdate({ root: project.root, profileId: value.profileId, caseId: value.caseId, renderer: raster.qa, allowRebaseline: true }); const inspection = inspectBrandQaBaselineProtocol(plan); const summary: BrandQaBaselinePlanSummary = Object.freeze({ profileId: plan.profileId, caseId: plan.caseId, baselinePath: plan.baselinePath, state: plan.state, oldBaselineDigest: plan.oldBaselineDigest, newBaselineDigest: plan.newBaselineDigest, oldQaDigest: plan.oldQaDigest, newQaDigest: plan.newQaDigest, renderer: Object.freeze({ id: plan.renderer.id, version: plan.renderer.version, qualificationId: plan.renderer.qualificationId, platformClaim: plan.renderer.platformClaim, rendererBuildDigest: raster.adapter.descriptor.rendererBuildDigest }), assetDigests: Object.freeze({ old: inspection.oldAssetDigest, next: inspection.newAssetDigest }), svgDigests: Object.freeze({ old: inspection.oldSvgDigest, next: inspection.newSvgDigest }), brandSystemDigests: Object.freeze({ old: inspection.oldBrandSystemDigest, next: inspection.newBrandSystemDigest }), rasterDifference: plan.rasterDifference }); const planBindings = bindings(session, method, value.projectHandle); authority = { plan, summary, envelope: envelope(session, method, { profileId: value.profileId, caseId: value.caseId }, { project: planBindings.root }, { project: project.digest, raster: raster.adapter.descriptor }, summary), bindings: planBindings, retention: inspectBrandQaBaselineUpdatePlanRetention(plan), dispose: disposeBrandQaBaselineUpdatePlan, revalidate: async (applySignal) => { await session.handles.revalidateProject(value.projectHandle, "existing"); if (!isQualifiedStudioRasterCapability(session.rasterCapability) || JSON.stringify(session.rasterCapability.adapter.descriptor) !== JSON.stringify(raster.adapter.descriptor)) throw new ProtocolError("PLAN_STALE"); check(applySignal); }, execute: async (authentic: BrandQaBaselineUpdatePlan, lifecycle) => executeBrandQaBaselineUpdatePlan(authentic, lifecycle.transactionHooks()), mutates: true };
  } else if (method === "brand.consumer.install.plan" || method === "brand.consumer.sync.plan") {
    const value = params as BrandConsumerPlanParams; const sources = await session.handles.leaseBrandSources(value.sourceHandles); let plan: ConsumerPlanSummary; try { const parameters = value.parameters === undefined ? undefined : Object.fromEntries(value.parameters.map((entry) => [entry.profileId, Object.fromEntries(entry.values.map((selected) => [selected.parameter, selected.value]))])); const options = { root: project.root, ...(value.profiles === undefined ? {} : { profiles: value.profiles }), ...(parameters === undefined ? {} : { parameters }) }; plan = method === "brand.consumer.install.plan" ? await planConsumerInstallWithVerifiedSources(options, sources) : await planConsumerSyncWithVerifiedSources(options, sources); } finally { await disposeConsumerSources(sources); } const summary = plan; const planBindings = bindings(session, method, value.projectHandle, value.sourceHandles); authority = { plan, summary, envelope: envelope(session, method, { profiles: value.profiles ?? null, parameters: value.parameters ?? null }, { project: planBindings.root, sources: planBindings.auxiliary ?? [] }, { project: project.digest }, summary), bindings: planBindings, retention: inspectConsumerPlanRetention(plan), dispose: disposeConsumerPlan, revalidate: async (applySignal) => { await session.handles.revalidateProject(value.projectHandle, "existing"); for (const handle of value.sourceHandles) await session.handles.brandSource(handle); check(applySignal); }, execute: async (authentic: ConsumerPlanSummary, lifecycle) => method === "brand.consumer.install.plan" ? executeConsumerInstallPlan(authentic, consumerHooks(lifecycle)) : executeConsumerSyncPlan(authentic, consumerHooks(lifecycle)), mutates: true };
  } else {
    if (!raster.available) throw new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE"); const value = params as BrandExportPlanParams; const plan = await planRasterExport(project.root, { profileId: value.profileId, ...(value.outputIds === undefined ? {} : { outputIds: value.outputIds }), capability: raster }); const summary: BrandRasterExportPlanSummary = Object.freeze({ profileId: plan.profileId, adapter: plan.adapter, outputs: plan.outputs, counts: plan.counts, warnings: plan.warnings }); const planBindings = bindings(session, method, value.projectHandle); authority = { plan, summary, envelope: envelope(session, method, { profileId: value.profileId, outputIds: value.outputIds ?? null }, { project: planBindings.root }, { project: project.digest, raster: raster.adapter.descriptor }, summary), bindings: planBindings, retention: inspectRasterExportPlanRetention(plan), dispose: disposeRasterExportPlan, revalidate: async (applySignal) => { await session.handles.revalidateProject(value.projectHandle, "existing"); if (!isQualifiedStudioRasterCapability(session.rasterCapability) || JSON.stringify(session.rasterCapability.adapter.descriptor) !== JSON.stringify(raster.adapter.descriptor)) throw new ProtocolError("PLAN_STALE"); check(applySignal); }, execute: async (authentic: RasterExportPlan, lifecycle) => executeRasterExportPlan(authentic, { hooks: rasterHooks(lifecycle) }), mutates: true };
  }
  check(signal); progress("ready", 1, 1); return authority;
}
