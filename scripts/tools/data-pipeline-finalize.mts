#!/usr/bin/env tsx
/**
 * Replay the deterministic finalization segment over a real preproduction result.
 * This tool never calls a model or a video provider.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { applyNarrativeFinalPromptContract } from "../../packages/video-studio/src/vendor-compat.js";
import { inspectFinalShotContract } from "../../packages/video-studio/src/final-shot-contract.js";
import { inspectFinalCharacterQualification } from "../../packages/video-studio/src/final-shot-character-qualification.js";

const arg = (name: string, fallback = ""): string => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};
const flag = (name: string): boolean => process.argv.includes(name);
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const repoRoot = resolve(import.meta.dirname ?? process.cwd(), "../..");
const resultPath = resolve(repoRoot, arg("--result"));
const outDir = resolve(repoRoot, arg("--out"));
if (!existsSync(resultPath)) throw new Error(`RESULT_NOT_FOUND: ${resultPath}`);

const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
  success?: boolean;
  stages?: {
    portraitStudio?: Record<string, unknown>;
    portraitResolver?: Record<string, unknown>;
    prdGeneration?: {
      data?: Record<string, unknown>;
    };
    productionEngine?: {
      shots?: Array<Record<string, unknown>>;
      prompts?: Array<Record<string, unknown>>;
    };
  };
};
const production = result.stages?.productionEngine;
const sourceShots = Array.isArray(production?.shots) ? production.shots : [];
if (sourceShots.length === 0) throw new Error("SHOTS_MISSING");

const promptConfig = createRequire(join(repoRoot, "package.json"))(
  join(repoRoot, "vendor/supermickey/hyperreality-system/config/prompt-length.js"),
) as { HARD_MAX?: number };
const maxLength = Number(arg("--max-prompt-length", String(promptConfig.HARD_MAX ?? 3000)));
const noDialogue = flag("--no-dialogue");
const aspect = arg("--aspect");
const resolution = arg("--resolution");
const fps = Number(arg("--fps"));
const deliveryConstraint = aspect || resolution || Number.isFinite(fps) && fps > 0
  ? [
      ...(aspect ? [`${aspect}画幅`] : []),
      ...(resolution ? [`${resolution}分辨率`] : []),
      ...(Number.isFinite(fps) && fps > 0 ? [`${fps}fps`] : []),
      "MP4格式。",
    ].join("，")
  : undefined;
const finalized = sourceShots.map((shot) =>
  applyNarrativeFinalPromptContract(shot, {
    noDialogue,
    maxLength,
    ...(deliveryConstraint ? { deliveryConstraint } : {}),
  }));
const contract = inspectFinalShotContract(finalized, { maxPromptLength: maxLength, noDialogue });
const prdData = result.stages?.prdGeneration?.data;
const characterSystem = prdData?.characterSystem && typeof prdData.characterSystem === "object"
  ? prdData.characterSystem as Record<string, unknown>
  : undefined;
const characterQualification = inspectFinalCharacterQualification({
  repoRoot,
  shots: finalized,
  portraitStudio: result.stages?.portraitStudio,
  portraitResolver: result.stages?.portraitResolver,
  ...(characterSystem ? { characterSystem } : {}),
});

const guardPath = join(
  repoRoot,
  "vendor/supermickey/hyperreality-system/engines/render-pipeline-guard.js",
);
const guardModule = createRequire(join(repoRoot, "package.json"))(guardPath) as {
  RenderPipelineGuard: new (options?: Record<string, unknown>) => {
    check(prompts: Array<Record<string, unknown>>): {
      pass: boolean;
      errors: Array<Record<string, unknown>>;
      warnings: Array<Record<string, unknown>>;
    };
  };
};
mkdirSync(outDir, { recursive: true });
const guard = new guardModule.RenderPipelineGuard({
  strictMode: true,
  logPath: join(outDir, "pipeline-guard-log.json"),
});
const guardResult = guard.check(finalized);
const totalDuration = finalized.reduce((sum, shot) => {
  const timing = shot.timing && typeof shot.timing === "object"
    ? shot.timing as Record<string, unknown>
    : {};
  return sum + (Number(shot.duration ?? timing.duration ?? 0) || 0);
}, 0);
const prompts = finalized.map((shot) => {
  const prompt = String(shot.prompt ?? "");
  return {
    shotId: String(shot.shotId ?? ""),
    sceneType: String(shot.sceneType ?? ""),
    durationSeconds: Number(shot.duration ?? 0),
    prompt,
    promptChars: prompt.length,
    promptSha256: sha256(prompt),
    degraded: shot.degraded === true,
    dialogue: String(shot.dialogue ?? ""),
    dialogueBlocks: Array.isArray(shot.dialogueBlocks) ? shot.dialogueBlocks : [],
  };
});
const sourceResultSha256 = sha256(readFileSync(resultPath));
const qualification = {
  schemaVersion: "workloom.video-render-qualification/v1",
  resultPath: resultPath.slice(repoRoot.length + 1),
  sourceResultSha256,
  mode: "real-model-output-deterministic-finalization-replay",
  providerSubmission: false,
  renderSubmitted: false,
  noDialogue,
  deliveryConstraint: deliveryConstraint ?? null,
  promptLimit: maxLength,
  shotCount: prompts.length,
  totalDurationSeconds: totalDuration,
  prompts,
  pipelineGuard: guardResult,
  finalShotContract: contract,
  characterQualification,
  status: guardResult.pass
    && contract.pass
    && characterQualification.pass
    && prompts.length > 0
    && prompts.every((item) => item.prompt.trim() && item.promptChars <= maxLength && !item.degraded)
    ? "eligible_pending_G8"
    : "blocked",
  remainingAuthority: [
    "G8 预算与围栏",
    "供应商模型资格",
    "本次提交的幂等请求哈希",
    "明确付费授权后由 render-operator 提交",
  ],
};

writeFileSync(join(outDir, "finalized-shots.json"), `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
writeFileSync(join(outDir, "prompts.json"), `${JSON.stringify(prompts, null, 2)}\n`, "utf8");
writeFileSync(join(outDir, "pipeline-guard.json"), `${JSON.stringify(guardResult, null, 2)}\n`, "utf8");
writeFileSync(join(outDir, "final-shot-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
writeFileSync(join(outDir, "qualification.json"), `${JSON.stringify(qualification, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(qualification, null, 2)}\n`);
process.exit(qualification.status === "eligible_pending_G8" ? 0 : 4);
