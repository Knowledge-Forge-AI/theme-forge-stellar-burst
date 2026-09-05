// @ts-check

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_ASSETS, sha256Hex, EXPECTED_README_SHA256 } from "./canonical-corpus.mjs";
import { generateTerminalNovaBrandProject } from "../qualify-terminal-nova-brand.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

/**
 * Load product APIs dynamically from dist
 */
export async function loadProductModules() {
  const url = new URL("../../dist/index.js", import.meta.url);
  return await import(url.href);
}

/**
 * Load raster capability module
 */
export async function loadRasterCapabilityHelper() {
  const resvgModule = await import("../../packages/tfsb-raster-resvg/index.js");
  const { createRasterCapabilityFromModule } = await import(new URL("../../dist/brand/raster-capability.js", import.meta.url).href);
  return createRasterCapabilityFromModule(resvgModule);
}

/**
 * Helper to unwrap Result
 * @param {any} result
 */
export function unwrapResult(result) {
  if (result.ok) return result.value;
  const first = result.diagnostics?.[0];
  throw new Error(`Diagnostic error: ${JSON.stringify(first ?? result)}`);
}

/**
 * Derive plan family registry from protocol 1.2 specifications
 */
export function derivePlanFamiliesRegistry() {
  const brandPlanFamilies = [
    { method: "brand.derive.plan", status: "supported", inScope: true, domain: "brand", description: "Derive updated brand target receipts and files" },
    { method: "brand.qa.baseline.plan", status: "supported", inScope: true, domain: "brand", description: "Create or update QA raster baselines" },
    { method: "brand.consumer.install.plan", status: "supported", inScope: true, domain: "brand", description: "Install brand profile assets into a consumer workspace" },
    { method: "brand.consumer.sync.plan", status: "supported", inScope: true, domain: "brand", description: "Synchronize and detect drift in consumer workspace" },
    { method: "brand.export.plan", status: "supported", inScope: true, domain: "brand", description: "Export brand raster outputs and write receipts" },
  ];

  const nonBrandPlanFamilies = [
    { method: "design_exchange.import.plan", status: "supported", inScope: false, reason: "Non-brand design-evidence workflow; verified in Nebular dogfood" },
    { method: "design_exchange.export.plan", status: "supported", inScope: false, reason: "Non-brand design-evidence workflow; verified in Nebular dogfood" },
    { method: "brief.create.plan", status: "supported", inScope: false, reason: "Human-agent design brief workflow; verified in Nebular dogfood" },
    { method: "candidate.import.plan", status: "supported", inScope: false, reason: "Candidate review workflow; verified in Nebular dogfood" },
    { method: "review.import.plan", status: "supported", inScope: false, reason: "Candidate review workflow; verified in Nebular dogfood" },
    { method: "review.export.plan", status: "supported", inScope: false, reason: "Candidate review workflow; verified in Nebular dogfood" },
    { method: "proposal.prefill.plan", status: "supported", inScope: false, reason: "Proposal draft workflow; verified in Nebular dogfood" },
    { method: "proposal.create.plan", status: "supported", inScope: false, reason: "Proposal confirmation workflow; verified in Nebular dogfood" },
  ];

  return {
    source: "literal-not-derived",
    totalPlanFamilies: brandPlanFamilies.length + nonBrandPlanFamilies.length,
    brandPlanFamilies,
    nonBrandPlanFamilies,
  };
}

/**
 * Exercise the complete core matrix for Terminal Nova brand.
 * @param {string} scratchRoot
 * @param {Record<string, { bytes: Uint8Array, sha256: string }>} assetMap
 * @param {Uint8Array} readmeBytes
 */
export async function executeTerminalNovaCoreMatrix(scratchRoot, assetMap, readmeBytes) {
  const product = await loadProductModules();
  const rasterCapability = await loadRasterCapabilityHelper();
  if (!rasterCapability.available) throw new Error("Raster capability unavailable");

  await rm(scratchRoot, { recursive: true, force: true });
  const results = {};

  // Deterministic runs
  const run1Dir = join(scratchRoot, "run1");
  const run2Dir = join(scratchRoot, "run2");
  await mkdir(run1Dir, { recursive: true });
  await mkdir(run2Dir, { recursive: true });

  const run1Project = join(run1Dir, "project");
  const run2Project = join(run2Dir, "project");
  await generateTerminalNovaBrandProject(run1Project, assetMap, readmeBytes);
  await generateTerminalNovaBrandProject(run2Project, assetMap, readmeBytes);

  // Bundle run 1
  const bundlePlan1 = await product.planBrandBundle({ root: run1Project, output: "bundle.zip" });
  await product.executeBrandBundle(bundlePlan1);
  const bundleZip1 = join(run1Project, "bundle.zip");
  const bundleBytes1 = await readFile(bundleZip1);
  const bundleSha1 = sha256Hex(bundleBytes1);

  // Bundle run 2
  const bundlePlan2 = await product.planBrandBundle({ root: run2Project, output: "bundle.zip" });
  await product.executeBrandBundle(bundlePlan2);
  const bundleZip2 = join(run2Project, "bundle.zip");
  const bundleBytes2 = await readFile(bundleZip2);
  const bundleSha2 = sha256Hex(bundleBytes2);

  results.determinism = {
    bundleShaEqual: bundleSha1 === bundleSha2,
    bundleBytesEqual: bundleBytes1.byteLength === bundleBytes2.byteLength,
    bundleSha: bundleSha1,
    bundleBytes: bundleBytes1.byteLength,
  };

  // 1. Derive plan
  const derivePlan = await product.planBrandDerivation({ root: run1Project, all: true });
  const deriveResult = await product.executeBrandDerivationPlan(derivePlan);
  results.derive = {
    status: "executed",
    updatedTargetsCount: deriveResult.updatedTargets?.length ?? 0,
    planSha: sha256Hex(JSON.stringify(derivePlan)),
  };

  // 2. QA baseline plan
  const qaBaselinePlan = await product.planBrandQaBaselineUpdate({
    root: run1Project,
    profileId: "terminal-nova-qa",
    caseId: "favicon-dark-baseline",
    renderer: rasterCapability.qa,
    create: {
      family: "terminal-nova",
      role: "favicon",
      variant: "favicon-on-dark",
      size: [16, 16],
      background: "token:near-black",
    },
    allowRebaseline: true,
  });
  const qaBaselineResult = await product.executeBrandQaBaselineUpdatePlan(qaBaselinePlan);
  results.qaBaseline = {
    status: "executed",
    state: qaBaselinePlan.state,
    baselinePath: qaBaselinePlan.baselinePath,
    newBaselineDigest: qaBaselinePlan.newBaselineDigest,
    written: qaBaselineResult.written,
  };

  // 3. Consumer install plan
  const consumerDir = join(run1Dir, "consumer");
  await mkdir(join(consumerDir, ".tfsb", "assets"), { recursive: true });
  await writeFile(
    join(consumerDir, ".tfsb", "project.toml"),
    'schema_version = 2\nname = "consumer"\n\n[build]\ndirectory = "dist"\n',
    "utf8",
  );
  const installPlan = await product.planConsumerInstall({
    root: consumerDir,
    sourceBundles: [bundleZip1],
    profiles: ["terminal-nova/astro-starlight"],
  });
  const installResult = await product.executeConsumerInstallPlan(installPlan);
  results.consumerInstall = {
    status: "executed",
    outputsWritten: installResult.writtenFiles?.length ?? null,
    planSha: sha256Hex(JSON.stringify(installPlan)),
  };

  // 4. Consumer clean sync (no-op)
  const cleanSyncPlan = await product.planConsumerSync({ root: consumerDir, sourceBundles: [bundleZip1] });
  const cleanSyncResult = await product.executeConsumerSyncPlan(cleanSyncPlan);
  results.consumerCleanSync = {
    status: "executed",
    outputsWritten: cleanSyncResult.writtenOutputs,
    isNoOp: cleanSyncResult.writtenOutputs === 0,
  };

  // 5. Destination drift detection
  const driftTarget = join(consumerDir, "docs/public/favicon.svg");
  const originalFavicon = await readFile(driftTarget);
  await writeFile(driftTarget, "<!-- drifted content -->", "utf8");
  let driftCode = null;
  try {
    await product.planConsumerSync({ root: consumerDir, sourceBundles: [bundleZip1] });
  } catch (err) {
    const errAny = /** @type {any} */ (err);
    driftCode = errAny?.diagnostic?.code ? String(errAny.diagnostic.code) : null;
  }
  await writeFile(driftTarget, originalFavicon);
  const restoredSyncPlan = await product.planConsumerSync({ root: consumerDir, sourceBundles: [bundleZip1] });
  const restoredSyncResult = await product.executeConsumerSyncPlan(restoredSyncPlan);
  results.destinationDrift = {
    driftDetected: driftCode === "CONSUMER_DRIFT",
    driftCode,
    restoredClean: restoredSyncResult.writtenOutputs === 0,
  };

  // 6. Stale plan detection
  const freshSyncPlan = await product.planConsumerSync({ root: consumerDir, sourceBundles: [bundleZip1] });
  const lockFile = join(consumerDir, ".tfsb/brand.lock.json");
  const lockContent = await readFile(lockFile, "utf8");
  await writeFile(lockFile, lockContent + "\n", "utf8");
  let staleCode = null;
  try {
    await product.executeConsumerSyncPlan(freshSyncPlan);
  } catch (err) {
    const errAny = /** @type {any} */ (err);
    staleCode = errAny?.diagnostic?.code ? String(errAny.diagnostic.code) : null;
  }
  await writeFile(lockFile, lockContent, "utf8");
  results.stalePlan = {
    staleDetected: staleCode === "CANONICAL_CHANGED_DURING_PLAN",
    staleCode,
  };

  // 7. Raster export plan and execute (supported capability-unavailable state)
  let rasterExportPlanned = 0;
  let rasterExportWritten = 0;
  let rasterExportStatus = "not-run";
  try {
    const exportPlan = await product.planRasterExport(run1Project, {
      profileId: "web-icons",
    });
    rasterExportPlanned = exportPlan.outputs?.length ?? 0;
    const exportResult = await product.executeRasterExportPlan(exportPlan);
    rasterExportWritten = exportResult.writtenFiles?.length ?? 0;
    rasterExportStatus = "executed";
  } catch (err) {
    const errAny = /** @type {any} */ (err);
    const code = errAny?.diagnostic?.code ? String(errAny.diagnostic.code) : null;
    if (code === "EXPORT_CAPABILITY_UNAVAILABLE") {
      rasterExportStatus = "raster-unavailable-semantic-only";
    } else {
      throw err;
    }
  }
  results.rasterExport = {
    status: rasterExportStatus,
    outputsPlanned: rasterExportPlanned,
    outputsWritten: rasterExportWritten,
  };

  // 8. Offline bundle consumer
  const offlineDir = join(scratchRoot, "offline-consumer");
  await mkdir(join(offlineDir, ".tfsb", "assets"), { recursive: true });
  await writeFile(
    join(offlineDir, ".tfsb", "project.toml"),
    'schema_version = 2\nname = "offline-consumer"\n\n[build]\ndirectory = "dist"\n',
    "utf8",
  );
  const offlineInstallPlan = await product.planConsumerInstall({
    root: offlineDir,
    sourceBundles: [bundleZip1],
    profiles: ["terminal-nova/astro-starlight"],
  });
  const offlineInstallResult = await product.executeConsumerInstallPlan(offlineInstallPlan);
  results.offlineConsumer = {
    status: "executed",
    outputsWritten: offlineInstallResult.writtenFiles?.length ?? null,
    networkObservation: "not-instrumented",
  };

  // 9. Limits boundary checks
  results.limits = {
    brandMaxReferencedAssets: product.BRAND_MAX_REFERENCED_ASSETS,
    brandImportLimits: product.BRAND_IMPORT_LIMITS,
    brandBundleLimits: product.BRAND_BUNDLE_LIMITS,
    brandConsumerLimits: product.BRAND_CONSUMER_LIMITS,
  };

  return results;
}
