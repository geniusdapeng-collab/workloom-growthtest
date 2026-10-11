/**
 * 同题复核（T-2026-1011-0001，不提交渲染）：把 820RR-RC 真机样本**当时生成的关键帧**
 * 送进 G-PLB2（pre-submit 审图闸），验证"换人/玩具比例/CG 感/缺头盔/保真"能否被模型判出。
 * 用法：pnpm exec tsx scripts/tools/plausibility-probe-plates.mts
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { reviewPlausibility } from "../../packages/video-studio/src/plausibility-review.ts";

const secrets: Record<string, string> = {};
const live = join(homedir(), ".workloom", "live.env");
if (existsSync(live)) for (const line of readFileSync(live, "utf8").split("\n")) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) secrets[m[1]!] = m[2]!;
}
const env = { ...process.env, LLM_PROVIDER: "deepseek", LLM_API_KEY: secrets.DEEPSEEK_API_KEY, LLM_BASE_URL: secrets.LLM_BASE_URL, LLM_MODEL: secrets.DEEPSEEK_MODEL };

const PLATES = "/Users/mac/Documents/Codex/2026-10-10/https-github-com-geniusdapeng-collab-workloom/work/workloom-growthtest/var/film/zxmoto-820rr-rc/work/plates/VID-ZXRRC-12";
const shots = [
  { shotId: "SC-01", durationSec: 5, scene: "清晨维修区通道", action: "陈卓走出阴影站定，说出开场句", character: "陈卓（系统1号模特，女性，166cm）", dialogue: [{ speaker: "陈卓", text: "Track only." }] },
  { shotId: "SC-02", durationSec: 5, scene: "赛道发车区", action: "赛车弹射起步、后轮打滑冲出画面，陈卓在维修墙前目送", dialogue: [{ speaker: "陈卓", text: "150 hp." }] },
  { shotId: "SC-03", durationSec: 5, scene: "车库内", action: "戴手套的手滑过排气尾段，侧脸抬起说出短句", character: "陈卓（仅手部与侧脸入画）", dialogue: [{ speaker: "陈卓", text: "Race spec." }] },
  { shotId: "SC-04", durationSec: 5, scene: "赛道高速弯", action: "赛车压弯、滑块火花、出弯", dialogueFree: true, product: "820RR-RC" },
  { shotId: "SC-05", durationSec: 5, scene: "维修墙上方", action: "陈卓望向赛道后转回镜头", dialogue: [{ speaker: "陈卓", text: "Race proven." }] },
  { shotId: "SC-06", durationSec: 5, scene: "黄昏车库门前", action: "陈卓拍车头说出车名", character: "陈卓", dialogue: [{ speaker: "陈卓", text: "820RR-RC." }] },
];

const result = await reviewPlausibility({
  projectId: "VID-ZXRRC-12-RECHECK",
  platform: "TikTok", locale: "en", aspect: "9:16", resolution: "1080p", durationSeconds: 30,
  character: { name: "陈卓", appearance: "系统默认 1 号模特（女性，约 166cm，深栗棕及肩发）" },
  products: [{
    id: "zxmoto-820rr-rc", displayName: "张雪机车 820RR-RC", brand: "ZXMOTO", category: "vehicle",
    dimensions: { lengthMm: 2050, seatHeightMm: 825, curbWeightKg: 190 }, photoAngles: ["three-quarter", "front", "rear"],
  }],
  shots,
  images: shots.flatMap((shot) => {
    const plate = join(PLATES, `${shot.shotId}-plate.png`);
    const material = join(PLATES, `${shot.shotId}-material.jpg`);
    const file = existsSync(plate) ? plate : existsSync(material) ? material : null;
    return file ? [{ label: `镜头 ${shot.shotId} 关键帧`, path: file }] : [];
  }),
  stage: "pre-submit",
}, { env });

console.log(`verdict=${result.verdict} | model=${result.model ?? "-"} | ${result.ms}ms`);
console.log(`reason: ${result.reason}`);
for (const finding of result.findings) {
  console.log(`[${finding.severity}] ${finding.shotId ?? "-"} ${finding.id}: ${finding.issue}`);
}
