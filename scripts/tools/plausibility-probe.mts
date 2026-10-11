/**
 * 跨品类验收探针（T-2026-1011-0001）：同一套"实体与物理常识审核 agent"，
 * 不新增任何品类规则，用真实模型判断 4 个互不相干的场景是否成立。
 * 用法：node_modules/.bin/tsx scripts/tools/plausibility-probe.mts
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { reviewPlausibility, type PlausibilityContextInput } from "../../packages/video-studio/src/plausibility-review.ts";

/** 把 ~/.workloom/live.env 的评审模型密钥注入环境（只在本进程内，不落盘）。 */
function loadSecrets(file = join(homedir(), ".workloom", "live.env")): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}
const secrets = loadSecrets();
const env = {
  ...process.env,
  LLM_PROVIDER: "deepseek",
  LLM_API_KEY: process.env.LLM_API_KEY ?? secrets.DEEPSEEK_API_KEY,
  // 评审模型走 OpenAI 兼容端点：live.env 里 LLM_BASE_URL=https://api.deepseek.com（DEEPSEEK_BASE_URL 是 anthropic 兼容端点，不能用于 /chat/completions）
  LLM_BASE_URL: process.env.LLM_BASE_URL ?? secrets.LLM_BASE_URL ?? secrets.DEEPSEEK_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL ?? secrets.DEEPSEEK_MODEL,
  DEEPSEEK_API_KEY: secrets.DEEPSEEK_API_KEY,
};

const cases: Array<{ name: string; context: PlausibilityContextInput }> = [
  {
    name: "① 摩托车（本案真机样本）：无人驾驶 + 台词镜无面部 + 中文口播",
    context: {
      projectId: "PROBE-MOTO", platform: "TikTok", locale: "en", aspect: "9:16", resolution: "1080p", durationSeconds: 30,
      character: { name: "陈卓", appearance: "东亚女性，身高约 166cm" },
      products: [{
        id: "zxmoto-820rr-rc", displayName: "张雪机车 820RR-RC", brand: "ZXMOTO", category: "vehicle",
        dimensions: { lengthMm: 2050, seatHeightMm: 825, curbWeightKg: 190 }, photoAngles: ["three-quarter", "front", "rear"],
      }],
      shots: [
        { shotId: "SC-02", durationSec: 5, scene: "赛道发车区", sceneDescription: "820RR-RC 后轮打滑、白烟翻涌，车头微抬冲出画面", action: "赛车弹射起步冲出画面", props: "赛车、发车格白线", dialogue: [{ speaker: "陈卓", text: "150 hp." }] },
        { shotId: "SC-03", durationSec: 5, scene: "车库", action: "戴手套的手滑过排气尾段，侧脸抬起说出短句", character: "陈卓（仅手部与侧脸入画）", props: "排气尾段、赛车", dialogue: [{ speaker: "陈卓", text: "Race spec." }] },
        { shotId: "SC-06", durationSec: 5, scene: "车库门前", action: "她拍车头正对镜头说出车名", character: "陈卓", props: "赛车（车头朝镜头）", dialogue: [{ speaker: "陈卓", text: "820RR-RC." }], promptText: "台词逐字：820RR-RC.；语言仅英文" },
      ],
      stage: "pre-render",
    },
  },
  {
    name: "② 汽车：无人驾驶驶出车库 + 未系安全带",
    context: {
      projectId: "PROBE-CAR", platform: "douyin", locale: "zh", aspect: "16:9", resolution: "1080p", durationSeconds: 30,
      products: [{ id: "demo-suv", displayName: "演示 SUV", category: "vehicle", dimensions: { lengthMm: 4700, heightMm: 1600 }, photoAngles: ["three-quarter", "side"] }],
      shots: [{ shotId: "C-01", durationSec: 5, scene: "地下车库", sceneDescription: "一辆 SUV 自己启动并缓缓驶出车位，车内空无一人", action: "SUV 加速驶出车库", props: "SUV" }],
      stage: "pre-render",
    },
  },
  {
    name: "③ 相机：悬空自动拍照（无摄影者、无支撑）",
    context: {
      projectId: "PROBE-CAMERA", platform: "xiaohongshu", locale: "zh", aspect: "9:16", resolution: "1080p", durationSeconds: 20,
      shots: [{ shotId: "M-01", durationSec: 5, scene: "影棚", sceneDescription: "一台微单相机悬在半空，镜头自己转动对焦，快门自动按下", action: "相机自动对焦并按下快门", props: "微单相机、镜头" }],
      stage: "pre-render",
    },
  },
  {
    name: "④ 牛肉馅饺子：塑料质感假食物 + 无使用状态 + 悬空",
    context: {
      projectId: "PROBE-DUMPLING", platform: "douyin", locale: "zh", aspect: "9:16", resolution: "1080p", durationSeconds: 15,
      shots: [{ shotId: "F-01", durationSec: 5, scene: "餐桌", sceneDescription: "一盘牛肉馅饺子悬在桌面上方，表面像塑料模型，没有热气", action: "镜头缓慢推近", props: "饺子、盘子" }],
      stage: "pre-render",
    },
  },
];

for (const item of cases) {
  const result = await reviewPlausibility(item.context, { env });
  console.log(`\n===== ${item.name}`);
  console.log(`verdict=${result.verdict} | model=${result.model ?? "-"} | ${result.ms}ms | ${result.reason}`);
  for (const finding of result.findings) {
    console.log(`  [${finding.severity}] ${finding.shotId ?? "-"} ${finding.id}: ${finding.issue}`);
    console.log(`      why: ${finding.why}`);
    console.log(`      fix: ${finding.fix}`);
  }
  for (const patch of result.promptPatches) console.log(`  patch ${patch.shotId}: ${patch.clauses.join(" / ")}`);
}
