#!/usr/bin/env tsx
/**
 * explainer-run.mts —— 口播解说片命令行（真机验收与运维入口）· T-2026-0926-0008
 *
 * 与服务端 `video.explainer.*` **共用同一条 pipeline**（apps/server/src/video/explainer/pipeline.ts）：
 * 差别只在装配面——CLI 直接接环境变量里的 LLM 与素材，不触库。
 *
 * 用法：
 *   pnpm explainer:run -- \
 *     --script var/scripts/chenzhuo-growth.md \
 *     --task-id 验收-陈卓 \
 *     --profile chen-zhuo-film \
 *     --host-portraits bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3 \
 *     --brand-product 获客增长系统 \
 *     [--quality hd|uhd] \
 *     [--shotbook var/shotbook.json] [--llm none|deepseek] [--assets assets.json]
 *     [--render-scope full|changed:s07] [--stop-after-render] [--dry-run]
 *
 * 素材（人物底板）：--host-portraits 指向定妆照目录时，会用 ffmpeg 生成三块「人物底板」
 * （半身正面 / 三分之四 / 特写，各 12s 极缓推近）到 var/talkcraft-assets/host/——
 * 这样"主角是陈卓"在**图与声**两侧都成立（声：音色档案；图：定妆照驱动的底板）。
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { runExplainerPipeline } from "../../apps/server/src/video/explainer/pipeline.js";
import { ExplainerQualitySchema, explainerOutputSize, ExplainerScriptSchema } from "../../apps/server/src/video/explainer/types.js";
import { templateDirOf } from "../../apps/server/src/video/explainer/project-builder.js";
import { engineStatus } from "../../apps/server/src/video/explainer/engine.js";
import type { LlmCall } from "../../apps/server/src/video/explainer/semantics.js";
import type { ExplainerShotbook } from "../../apps/server/src/video/explainer/types.js";
import type { ShotPlan } from "../../apps/server/src/video/explainer/shotbook.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1]!.startsWith("--") ? args[index + 1] : fallback;
};
const has = (name: string): boolean => args.includes(`--${name}`);

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function readScript(path: string): { i: number; text: string }[] {
  const raw = readFileSync(path, "utf8");
  const sentences: string[] = [];
  for (const paragraph of raw.split(/\n+/)) {
    const clean = paragraph.replace(/^\s*[-*#>\d.、]+\s*/, "").trim();
    if (!clean || clean.startsWith("<!--")) continue;
    const parts = clean.match(/[^。！？!?]+[。！？!?]?/g) ?? [clean];
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) sentences.push(trimmed);
    }
  }
  if (sentences.length === 0) throw new Error(`口播稿没有可读句子：${path}`);
  return sentences.map((text, index) => ({ i: index + 1, text }));
}

/** DeepSeek / OpenAI 兼容 LLM（CLI 路径；服务端走 model-router 的 routedLlmCall） */
function llmFromEnv(): LlmCall | undefined {
  const mode = opt("llm", "auto");
  if (mode === "none") return undefined;
  /**
   * base URL 归一：本机 live.env 的 DEEPSEEK_BASE_URL 指向 **Anthropic 兼容端点**
   * （https://api.deepseek.com/anthropic），OpenAI 兼容调用要去掉这段后缀——
   * 否则 POST 到 /anthropic/chat/completions 会 404（真机踩过）。
   */
  const rawBase = opt("llm-base")
    ?? process.env.TALKCRAFT_LLM_BASE_URL
    ?? process.env.LLM_BASE_URL
    ?? process.env.DEEPSEEK_BASE_URL
    ?? "";
  const baseUrl = rawBase.trim().replace(/\/+$/, "").replace(/\/anthropic$/, "");
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? "";
  const model = opt("llm-model") ?? process.env.TALKCRAFT_LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? process.env.LLM_MODEL ?? "deepseek-chat";
  if (!baseUrl || !apiKey) {
    if (mode === "deepseek") throw new Error("--llm deepseek 要求 DEEPSEEK_BASE_URL/DEEPSEEK_API_KEY（或 LLM_BASE_URL/LLM_API_KEY）");
    log("[cli] 未配置 LLM → 分镜走规则兜底（allowRuleShotbook=true）");
    return undefined;
  }
  return async (prompt: string, opts?: { system?: string }) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          ...(opts?.system ? [{ role: "system", content: opts.system }] : []),
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
        max_tokens: 8000,
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM 返回为空");
    return content;
  };
}

/** 定妆照 → 人物底板（12s 极缓推近；H.264 CRF18，1080×1440 中心裁切） */
function buildHostPlanks(portraitsDir: string, outDir: string): Record<string, string> {
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(portraitsDir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
  const pick = (keywords: string[]): string | null => {
    for (const keyword of keywords) {
      const hit = files.find((f) => f.includes(keyword));
      if (hit) return join(portraitsDir, hit);
    }
    return null;
  };
  const front = pick(["-front", "front"]);
  const threeQuarter = pick(["-threeQuarter", "threeQuarter", "-side"]);
  const closeup = pick(["-closeup", "closeup", "-emotionCloseup"]);
  if (!front) throw new Error(`定妆照目录里找不到正面照：${portraitsDir}`);
  const mapping: Array<[string, string, string]> = [
    ["半身", "host-front.mp4", front],
    ["角标左下", "host-three-quarter.mp4", threeQuarter ?? front],
    ["角标右下", "host-closeup.mp4", closeup ?? front],
    ["分屏格", "host-front.mp4", front],
    ["default", "host-front.mp4", front],
  ];
  const built: Record<string, string> = {};
  const cache = new Map<string, string>();
  for (const [form, name, source] of mapping) {
    const target = join(outDir, name);
    if (!cache.has(name)) {
      if (!existsSync(target) || statSync(target).size < 100_000) {
        const filter = [
          "scale=1620:-2",
          "crop=1080:1440:(iw-1080)/2:(ih-1440)/3",
          "zoompan=z='min(1.06,1.012+0.0008*on)':x='iw/2-(iw/zoom/2)':y='ih/3-(ih/zoom/3)':d=360:s=1080x1440:fps=30",
          "format=yuv420p",
        ].join(",");
        const cmd = (process.env.FFMPEG_PATH ?? "ffmpeg");
        const result = spawnSync(cmd, [
          "-y", "-hide_banner", "-loglevel", "error", "-i", source,
          "-filter_complex", filter, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-t", "12", target,
        ], { encoding: "utf8" });
        if ((result.status ?? -1) !== 0) {
          throw new Error(`人物底板生成失败（${source}）：${(result.stderr ?? "").slice(-300)}`);
        }
        log(`[cli] 人物底板 ${name} ← ${source.split("/").pop()}`);
      }
      cache.set(name, target);
    }
    built[form] = cache.get(name)!;
  }
  return built;
}

async function main(): Promise<void> {
  const status = engineStatus();
  log(`[cli] 引擎：installed=${status.installed} ready=${status.ready} 卡=${status.cardCount} 许可=${status.license.scope}`);
  if (!status.installed || !status.runtimeInstalled) {
    throw new Error(`引擎未就绪：${status.reason}（先跑 pnpm talkcraft:install -- --with-runtime）`);
  }
  const scriptPath = opt("script");
  if (!scriptPath) throw new Error("缺少 --script <口播稿文件>");
  const taskId = opt("task-id", `run-${Date.now().toString(36)}`)!;
  const profile = opt("profile", process.env.WORKLOOM_VOICE_PROFILE ?? "zh-myvoice")!;
  const aspect = (opt("aspect", "9:16") as "9:16" | "16:9");
  const quality = ExplainerQualitySchema.parse(opt("quality", "hd"));
  const brandProduct = opt("brand-product", "WorkLoom 获客增长系统")!;
  const script = ExplainerScriptSchema.parse({ sentences: readScript(resolve(scriptPath)) });
  log(`[cli] 口播稿 ${script.sentences.length} 句 / ${script.sentences.map((s) => s.text.replace(/\s/g, "").length).reduce((a, b) => a + b, 0)} 字`);

  const hostPortraits = opt("host-portraits");
  const hostAssets = hostPortraits
    ? buildHostPlanks(resolve(hostPortraits), join(REPO_ROOT, "var/talkcraft-assets/host"))
    : undefined;

  const shotbookPath = opt("shotbook");
  const shotbook = shotbookPath
    ? (JSON.parse(readFileSync(resolve(shotbookPath), "utf8")) as ExplainerShotbook)
    : undefined;
  const planPath = opt("shotbook-plan");
  const shotbookPlan = planPath
    ? (JSON.parse(readFileSync(resolve(planPath), "utf8")) as ShotPlan)
    : undefined;

  const assets = opt("assets")
    ? (JSON.parse(readFileSync(resolve(opt("assets")!), "utf8")) as Array<{ from: string; to: string }>)
    : undefined;

  const output = await runExplainerPipeline({
    taskId,
    script,
    shotbook,
    shotbookPlan,
    voice: { source: "tts", profile },
    aspect,
    quality,
    brand: {
      product: brandProduct,
      tone: "专业、克制、有结论（销售向口播）",
      accent: "#7A5AF8",
      base: "#0B1020",
      ink: "#F5F7FF",
    },
    hostAssets,
    assets,
    llm: llmOf(shotbook, shotbookPlan),
    allowRuleShotbook: true,
    templateDir: templateDirOf(),
    renderScope: opt("render-scope", "full"),
    stopAfterRender: has("stop-after-render"),
    resumeFrom: has("resume") ? "render" : undefined,
    onLog: log,
  });

  const summary = {
    taskId: output.taskId,
    jobDir: output.jobDir,
    shots: output.shotbook.shots.length,
    cards: output.build.cards,
    seconds: output.timestamps.total,
    quality,
    resolution: explainerOutputSize(aspect, quality),
    sentences: output.timestamps.sentences.length,
    lowMatch: output.timestamps.sentences.filter((s) => !s.ok).map((s) => s.i),
    render: output.renderVideoPath,
    delivery: output.delivery?.deliveryPath ?? null,
    deliverySha256: output.delivery?.sha256 ?? null,
    deliveryBytes: output.delivery?.bytes ?? null,
    loudnorm: output.delivery?.measurement ?? null,
    gates: output.qa.gates.map((g) => ({ gate: g.gate, status: g.status, summary: g.summary })),
    qaPass: output.qa.pass,
  };
  const reportPath = join(output.jobDir, "run-report.json");
  writeFileSync(reportPath, JSON.stringify(summary, null, 1));
  log(`\n[cli] 完成：${reportPath}`);
  log(JSON.stringify(summary, null, 1));
}

function llmOf(shotbook?: ExplainerShotbook, plan?: ShotPlan): LlmCall | undefined {
  if (shotbook || plan) return undefined; // 指定了分镜/分镜计划 → 不再调 LLM（省时省钱，结果可复现）
  return llmFromEnv();
}

main().catch((err) => {
  console.error(`[cli] 失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
