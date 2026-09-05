// @ts-check

/**
 * Pinned CI contract for TFSB49 PR-only qualification.
 */

export const REQUIRED_JOBS = Object.freeze([
  "source-integrity",
  "root-package",
  "native-directory-snapshot",
  "visual-accessibility",
  "raster-companion",
  "studio-frontend",
  "nebular-macos-arm64",
  "terminal-nova-integration",
  "supply-chain",
  "evidence-aggregate",
]);

export const STELLAR_BURST_PUBLIC_REQUIRED_JOBS = Object.freeze([
  "source-policy",
  "root-package",
  "native-directory-snapshot",
  "visual-accessibility",
  "raster-companion",
  "codeql",
  "supply-chain",
  "evidence-aggregate",
]);

export const NEBULAR_FUSION_PUBLIC_REQUIRED_JOBS = Object.freeze([
  "source-policy",
  "frontend",
  "macos-arm64",
  "codeql",
  "supply-chain",
  "evidence-aggregate",
]);

export const NATIVE_SNAPSHOT_TUPLES = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64-gnu",
]);

export const RASTER_COMPANION_TUPLES = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64-gnu",
  "windows-x64",
]);

/**
 * Artifact populations emitted by the standalone public workflows.  These
 * inventories intentionally contain only files produced by that product's
 * jobs; the private combined-workflow population remains in the aggregator.
 */
/**
 * @param {string} directory
 * @param {string} job
 * @param {Record<string, string>} matrix
 * @param {readonly string[]} required
 * @param {"staging-head" | "merge-candidate"} [checkoutRole]
 */
const publicArtifact = (directory, job, matrix, required, checkoutRole = "merge-candidate") => Object.freeze({
  directory,
  job,
  matrix: Object.freeze({ ...matrix }),
  required: Object.freeze([...required]),
  checkoutRole,
});

export const STELLAR_BURST_PUBLIC_ARTIFACTS = Object.freeze([
  publicArtifact("source-policy-receipt", "source-policy", {}, ["receipt.json"], "staging-head"),
  publicArtifact("root-package-artifacts", "root-package", {}, ["receipt.json", "pack-manifest.json", "test-report.json", "audit-result.json", "root-package.tgz"]),
  ...NATIVE_SNAPSHOT_TUPLES.map((tuple) => publicArtifact(`native-artifacts-${tuple}`, "native-directory-snapshot", { tuple }, ["receipt.json", "native-report.json", "native-manifest.json", "native-addon-posix-openat-v1.node"])),
  publicArtifact("visual-artifacts", "visual-accessibility", {}, ["receipt.json", "visual-summary.json", "playwright-evidence*"]),
  ...RASTER_COMPANION_TUPLES.map((tuple) => publicArtifact(`raster-companion-${tuple}`, "raster-companion", { tuple }, ["receipt.json", "raster-report.json", "packed-consumer-report.json", "root-package.tgz", "root-pack-manifest.json", "raster-companion.tgz", "raster-pack-manifest.json"])),
  publicArtifact("supply-chain-artifacts", "supply-chain", {}, ["receipt.json", "root-package.syft.json", "root-package.spdx.json", "root-package.cdx.json", "root-package.grype.json", "root-package.grype.sarif", "root-package.receipt.json", "workflow-checks/actionlint.result.json", "workflow-checks/zizmor.result.json", "workflow-checks/betterleaks.result.json", "workflow-checks/workflow-checks.receipt.json", "workflow-checks/betterleaks.report.json"]),
]);

export const NEBULAR_FUSION_PUBLIC_ARTIFACTS = Object.freeze([
  publicArtifact("source-policy-receipt", "source-policy", {}, ["receipt.json"], "staging-head"),
  publicArtifact("frontend-artifacts", "frontend", {}, ["receipt.json", "frontend-dist.tar.gz"]),
  publicArtifact("nebular-macos-arm64-artifacts", "macos-arm64", {}, ["receipt.json", "node-authenticity/receipt.json", "node-authenticity/SHASUMS256.txt.asc", "node-runtime", "sidecar-payload.tar.gz", "sidecar-transcript.json", "nebular-fusion.app.tar.gz", "bundle-identity.json", "signing-facts.json"]),
  publicArtifact("supply-chain-artifacts", "supply-chain", {}, ["receipt.json", "nebular-fusion.syft.json", "nebular-fusion.spdx.json", "nebular-fusion.cdx.json", "nebular-fusion.grype.json", "nebular-fusion.grype.sarif", "nebular-fusion.receipt.json", "workflow-checks/actionlint.result.json", "workflow-checks/zizmor.result.json", "workflow-checks/betterleaks.result.json", "workflow-checks/workflow-checks.receipt.json", "workflow-checks/betterleaks.report.json", "cargo-audit.json"]),
]);

/**
 * Frozen generic-Studio ten-command ACL.
 */
export const STUDIO_ACL_TEN_COMMANDS = Object.freeze([
  "studio_brand_read",
  "studio_brand_plan_start",
  "studio_brand_plan_cancel",
  "studio_host_start",
  "studio_host_status",
  "studio_select_project",
  "studio_select_source",
  "studio_host_shutdown",
  "studio_design_packet_import",
  "studio_design_packet_export",
]);

export const CANONICAL_TERMINAL_NOVA = Object.freeze({
  repository: "Knowledge-Forge-AI/theme-forge-terminal-nova",
  commit: "461d9add96ed6c04b341e31305697a9046eed1a8",
  tree: "5857f60d230ca97cb586ccdd45dd54635ca1d9b7",
});

export const NODE_RELEASE_IDENTITY = Object.freeze({
  version: "22.23.2",
  darwinArm64TarballSha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  nodeExecutableSha256: "18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572",
  nodeExecutableSize: 112_937_728,
  signingKeyFingerprint: "CC68F5A3106FF448322E48ED27F5E38D5B0A215F", // betterleaks:allow -- public Node.js release signing-key fingerprint
  signingKeyReleaser: "Marco Ippolito <marcoippolito54@gmail.com>",
});

export const CARGO_AUDIT_IDENTITY = Object.freeze({
  package: "cargo-audit",
  version: "0.22.2",
  installMode: "cargo-install-locked",
});

export const CANONICAL_TERMINAL_NOVA_ARCHIVE_SHA256 = "2a0e82c43490687053cf41d5e214dfc10f9b2ef145d14b0354203f8bf8dfea24";

export const WASM_RENDERER_IDENTITY = Object.freeze({
  package: "@resvg/resvg-wasm",
  version: "2.6.2",
  size: 2_478_606,
  sha256: "22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70",
});

export const LIFECYCLE_STATE = Object.freeze({
  tfsb48: "accepted",
  tfsb49a: "superseded",
  tfsb49b: "source repairs implemented; qualification is packet-bound",
  tfsb49c: "awaiting explicit authority",
  tfsb49d: "not yet authorized",
  tfsb50: "not authorized",
});
