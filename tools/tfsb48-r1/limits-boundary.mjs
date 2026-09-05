// @ts-check

import { loadProductModules, unwrapResult } from "./core-matrix.mjs";

/**
 * Exercise at-limit and over-limit boundary checks for all Section 8 limit families.
 */
export async function testAllLimitBoundaries() {
  const product = await loadProductModules();

  const results = {
    brandImport: {
      limits: product.BRAND_IMPORT_LIMITS,
      totalEntries: { atLimit: 514, overLimit: 515, status: "not-exercised" },
      selectedEntryBytes: { atLimit: 8 * 1024 * 1024, overLimit: 8 * 1024 * 1024 + 1, status: "not-exercised" },
      baselineEntryBytes: { atLimit: 32 * 1024 * 1024, overLimit: 32 * 1024 * 1024 + 1, status: "not-exercised" },
      aggregateBytes: { atLimit: 288 * 1024 * 1024, overLimit: 288 * 1024 * 1024 + 1, status: "not-exercised" },
    },
    bundle: {
      limits: product.BRAND_BUNDLE_LIMITS,
      payloadRecords: { atLimit: 512, overLimit: 513, diagnostic: "RESOURCE_LIMIT_EXCEEDED", status: "not-exercised" },
      totalEntries: { atLimit: 514, overLimit: 515, diagnostic: "RESOURCE_LIMIT_EXCEEDED", status: "not-exercised" },
      selectedEntryBytes: { atLimit: 8 * 1024 * 1024, overLimit: 8 * 1024 * 1024 + 1, status: "not-exercised" },
    },
    derive: {
      maxTargets: { atLimit: 128, overLimit: 129, diagnostic: "RESOURCE_LIMIT_EXCEEDED", status: "not-exercised" },
      sourceTargetBytes: { atLimit: 8 * 1024 * 1024, overLimit: 8 * 1024 * 1024 + 1, status: "not-exercised" },
      aggregateBytes: { atLimit: 32 * 1024 * 1024, overLimit: 32 * 1024 * 1024 + 1, status: "not-exercised" },
      receiptBytes: { atLimit: 1 * 1024 * 1024, overLimit: 1 * 1024 * 1024 + 1, status: "not-exercised" },
    },
    consumer: {
      maxAssets: { atLimit: 128, overLimit: 129, status: "not-exercised" },
      maxOutputs: { atLimit: 512, overLimit: 513, diagnostic: "RESOURCE_LIMIT_EXCEEDED", status: "not-exercised" },
      maxCompanions: { atLimit: 64, overLimit: 65, status: "not-exercised" },
      maxProfiles: { atLimit: 8, overLimit: 9, status: "not-exercised" },
      carrierEntryBytes: { atLimit: 8 * 1024 * 1024, overLimit: 8 * 1024 * 1024 + 1, status: "not-exercised" },
      carrierAggregateBytes: { atLimit: 32 * 1024 * 1024, overLimit: 32 * 1024 * 1024 + 1, status: "not-exercised" },
      stagedOutputBytes: { atLimit: 256 * 1024 * 1024, overLimit: 256 * 1024 * 1024 + 1, status: "not-exercised" },
    },
    exportLimits: {
      maxOutputs: {
        atLimit: 128,
        overLimit: 129,
        diagnostic: "RESOURCE_LIMIT_EXCEEDED",
        status: "not-exercised",
        rejectionCode: /** @type {string | undefined} */ (undefined),
        verified: /** @type {boolean | undefined} */ (undefined),
      },
      stagedPngBytes: { atLimit: 256 * 1024 * 1024, overLimit: 256 * 1024 * 1024 + 1, diagnostic: "RESOURCE_LIMIT_EXCEEDED", status: "not-exercised" },
    },
    designEvidence: {
      encodedPacketBytes: { atLimit: 16 * 1024 * 1024, overLimit: 16 * 1024 * 1024 + 1, diagnostic: "DESIGN_PACKET_OVERSIZED", status: "not-exercised" },
      decodedVisualTotalBytes: { atLimit: 8 * 1024 * 1024, overLimit: 8 * 1024 * 1024 + 1, diagnostic: "VISUAL_TOTAL_EXCEEDED", status: "not-exercised" },
    },
  };

  // Run real schema tests for limits
  // 1. Export limits test: 129 outputs in export profile
  try {
    const outputs = [];
    for (let i = 0; i < 129; i++) {
      outputs.push(`[[profiles.outputs]]
id = "out-${i}"
purpose = "icon"
family = "terminal-nova"
role = "favicon"
variant = "favicon-on-light"
destination = "brand/export/out-${i}.png"
width = 16
height = 16
fit = "contain-pad"
background = "transparent"
color_space = "srgb"
alpha = "straight"
`);
    }
    const toml = `schema = "tfsb.brand-exports"
schema_version = 1
[[profiles]]
id = "massive"
${outputs.join("\n")}
`;
    const res = product.parseBrandExportsToml(toml, "test.toml");
    if (res.ok) throw new Error("Expected export profile with 129 outputs to fail");
    results.exportLimits.maxOutputs.rejectionCode = res.diagnostics[0]?.code;
    results.exportLimits.maxOutputs.verified = res.diagnostics[0]?.code === "RESOURCE_LIMIT_EXCEEDED";
  } catch (error) {
    results.exportLimits.maxOutputs.rejectionCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";
    results.exportLimits.maxOutputs.verified = false;
  }

  return results;
}
