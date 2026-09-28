// @ts-check
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSarifFindings, normalizeFindingsCollection } from "./finding-ratchet.mjs";
const [input, output, product, tool, category] = process.argv.slice(2);
if (!input || !output || !product || !tool) throw new Error("input output product tool category required");
const digest = (/** @type {Buffer} */ b) => createHash("sha256").update(b).digest("hex");
/** @type {any} */
const report = { schema: "tfsb.security-report-v1", status: "unavailable", binding: {
  repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT, analyzedCommit: process.env.GITHUB_SHA,
  workflowRef: process.env.GITHUB_WORKFLOW_REF, category, product, tool,
}, reports: [], findings: [] };
try {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH || "", "utf8"));
  report.binding.prHead = event.pull_request?.head?.sha ?? process.env.GITHUB_SHA;
  report.binding.pr = event.pull_request?.number ?? null;
  report.binding.workflowSha256 = digest(await readFile(".github/workflows/ci.yml"));
  const st = await stat(input);
  const files = st.isDirectory() ? (await readdir(input)).filter(n => n.endsWith(".sarif")).sort().map(n => join(input,n)) : [input];
  if (!files.length) throw new Error("SARIF unavailable: no report files");
  for (const file of files) {
    const raw = await readFile(file);
    const rawSha256 = digest(raw);
    report.reports.push({ path: file, bytes: raw.length, sha256: rawSha256 });
    const sarif = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(sarif.runs) || !sarif.runs.length || sarif.runs.some((/** @type {any} */ r) => !Array.isArray(r.results))) throw new Error("Malformed or incomplete SARIF runs/results");
    const findings = parseSarifFindings(sarif, product, tool);
    report.findings.push(...findings.map(f => ({...f, evidence: {...f.evidence, rawSha256}})));
  }
  report.findings = normalizeFindingsCollection(report.findings);
  report.status = "complete";
} catch (error) {
  report.status = "unavailable";
  report.error = error instanceof Error ? error.message : "report generation failed";
  process.exitCode = 1;
} finally {
  await mkdir(resolve(output, ".."), {recursive:true});
  await writeFile(output, JSON.stringify(report,null,2)+"\n");
}
