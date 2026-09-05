import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { buildProject, executeConsumerAdoptionPlan, inspectConsumerState, installProject, planConsumerAdoption } from "../../src/index.js";
import { createConsumerBundle, createConsumerProject, PROFILE_ID } from "./consumer-test-helper.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function explicitConsumer(producerRoot: string): Promise<string> {
  const consumer = await createConsumerProject();
  await cp(`${producerRoot}/.tfsb/assets/fixture-mark-on-light.toml`, `${consumer}/.tfsb/assets/fixture-mark-on-light.toml`);
  await mkdir(`${consumer}/.tfsb/companions`, { recursive: true });
  await cp(`${producerRoot}/GUIDANCE.md`, `${consumer}/.tfsb/companions/GUIDANCE.md`);
  const projectPath = `${consumer}/.tfsb/project.toml`;
  await writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n[[install]]\nasset = "fixture-mark-on-light"\ndestinations = ["public/fixture-mark.svg"]\n\n[[companion]]\nfile = "GUIDANCE.md"\ndestinations = ["GUIDANCE-BRAND.md"]\n`);
  await buildProject(consumer);
  await installProject(consumer);
  return consumer;
}

describe("equal-byte ownership adoption", () => {
  it("moves exact complete-profile ownership without changing external bytes", async () => {
    const producer = await createConsumerBundle(); roots.push(producer.root);
    const consumer = await explicitConsumer(producer.root); roots.push(consumer);
    const beforeAsset = await readFile(`${consumer}/public/fixture-mark.svg`), beforeCompanion = await readFile(`${consumer}/GUIDANCE-BRAND.md`);
    const plan = await planConsumerAdoption({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] });
    const result = await executeConsumerAdoptionPlan(plan);
    expect(result.writtenOutputs).toBe(0);
    expect(await readFile(`${consumer}/public/fixture-mark.svg`)).toEqual(beforeAsset);
    expect(await readFile(`${consumer}/GUIDANCE-BRAND.md`)).toEqual(beforeCompanion);
    const project = await readFile(`${consumer}/.tfsb/project.toml`, "utf8");
    expect(project).not.toContain("[[install]]"); expect(project).not.toContain("[[companion]]");
    expect((await inspectConsumerState({ root: consumer, sourceBundles: [producer.archive] })).status).toBe("ok");
  });

  it("rejects unequal explicit-source or installed bytes", async () => {
    const producer = await createConsumerBundle(); roots.push(producer.root);
    const consumer = await explicitConsumer(producer.root); roots.push(consumer);
    await writeFile(`${consumer}/GUIDANCE-BRAND.md`, "changed");
    await expect(planConsumerAdoption({ root: consumer, sourceBundles: [producer.archive], profiles: [PROFILE_ID] })).rejects.toThrow(/not exact explicit ownership/);
  });
});
