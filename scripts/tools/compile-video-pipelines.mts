#!/usr/bin/env tsx
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";
import {
  DEFAULT_KNOWN_GATES,
  LEGACY_STAGE_ADAPTERS,
  parseAndCompilePipeline,
  type CompiledPipelinePlan,
} from "../../packages/video-studio/src/pipeline-control-plane/compiler.ts";

const ROOT = process.cwd();
const PIPELINES = path.join(ROOT, "bundles/ai-video/pipelines");
const PRESETS = path.join(ROOT, "bundles/ai-video/presets");
const MANIFEST = path.join(PIPELINES, "compiled-plan-manifest.json");

async function knownOwners(): Promise<ReadonlySet<string>> {
  const owners = new Set<string>();
  for (const name of await readdir(PRESETS)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const document = YAML.parse(await readFile(path.join(PRESETS, name), "utf8")) as { preset_key?: unknown };
    if (typeof document?.preset_key === "string") owners.add(document.preset_key);
  }
  return owners;
}

async function compileAll(): Promise<CompiledPipelinePlan[]> {
  const owners = await knownOwners();
  const names = (await readdir(PIPELINES))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  return Promise.all(names.map(async (name) =>
    parseAndCompilePipeline(await readFile(path.join(PIPELINES, name), "utf8"), {
      knownOwners: owners,
      knownGates: DEFAULT_KNOWN_GATES,
      adapterRegistry: LEGACY_STAGE_ADAPTERS,
    })));
}

const plans = await compileAll();
const manifest = {
  schemaVersion: "workloom.compiled-pipeline-manifest/v1",
  generatedBy: "scripts/tools/compile-video-pipelines.mts",
  plans: plans.map((plan) => ({
    pipelineKey: plan.pipelineKey,
    name: plan.name,
    version: plan.version,
    sourceDigest: plan.sourceDigest,
    planHash: plan.planHash,
    steps: plan.steps.length,
    edges: plan.edges.length,
    adapters: [...new Set(plan.steps.map((step) => step.adapterId))].sort(),
    gates: [...new Set(plan.steps.flatMap((step) => step.verify.gate ? [step.verify.gate] : []))].sort(),
  })),
};
const output = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes("--write")) {
  await writeFile(MANIFEST, output, "utf8");
  console.log(`compiled ${plans.length} pipelines -> ${path.relative(ROOT, MANIFEST)}`);
} else {
  const existing = await readFile(MANIFEST, "utf8").catch(() => "");
  if (existing !== output) {
    console.error("PIPELINE_MANIFEST_STALE: run `pnpm pipelines:compile`");
    process.exitCode = 1;
  } else {
    console.log(`verified ${plans.length} compiled pipelines`);
  }
}
