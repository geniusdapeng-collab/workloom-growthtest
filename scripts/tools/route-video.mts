#!/usr/bin/env tsx
/**
 * route-video.mts —— 视频管线**分流**命令行（营销片 / 叙事片 / 口播解说片 / 待澄清）
 *
 * 为什么要有它（真机事故复盘 2026-09-30）：
 *   分流逻辑（`packages/video-studio/src/pipeline-router.ts`）此前只接在**服务端派活**
 *   （`apps/server/src/video/router.ts`、`trpc/router.ts`）上。而 AI agent / 交付同学是直接跑 CLI 的，
 *   没有分流入口 → 会**跳过"先判视频类型再选管线"**这一步，直接调 `full-chain-film.mts`：
 *   营销片该有的商品情报档案、G1 门与商品锚点都被绕开；判不准时也不会向用户澄清。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/route-video.mts --title "给示例企业做一条抖音投放片，卖自助入住机"
 *   pnpm exec tsx scripts/tools/route-video.mts --title "..." --brief work/film/brief.json --llm
 *   pnpm exec tsx scripts/tools/route-video.mts --title "..." --explicit marketing      # 已确认过的项目补跑
 *   ... [--product "示例品牌 AI 智慧前台"] [--brand 示例品牌] [--platform 抖音] [--out route.json]
 *
 * 判别口径（与产品一致）：显式指定 → 用户显式声明 → 规则打分 → 商品锚点 → LLM 仲裁 → **不确定就澄清**。
 * 纪律：**不猜商品**（商品名只来自显式声明/metadata/模型抽取）；判不准宁可问用户，不替用户花钱。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildPipelineIntent,
  describeRouteDecision,
  routeVideoPipeline,
  type VideoPipelineKind,
} from "../../packages/video-studio/src/pipeline-router.js";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name: string): boolean => process.argv.includes(name);

const positional = process.argv.slice(2).filter((token, index, all) => !token.startsWith("--") && !(index > 0 && all[index - 1]!.startsWith("--")));
const title = arg("--title", positional.join(" ").trim());
if (!title) {
  console.error("用法：route-video.mts --title \"<视频需求原文>\" [--brief brief.json] [--product 名称] [--explicit marketing|narrative|explainer] [--llm] [--out route.json]");
  process.exit(2);
}
const explicitRaw = arg("--explicit").trim();
const explicit = (["marketing", "narrative", "explainer"] as const).includes(explicitRaw as VideoPipelineKind)
  ? (explicitRaw as VideoPipelineKind)
  : undefined;
if (explicitRaw && !explicit) {
  console.error(`--explicit 只支持 marketing / narrative / explainer，收到：${explicitRaw}`);
  process.exit(2);
}

/** metadata：把 brief 原样带上，并允许 --product/--brand 显式补商品锚点（营销片必需） */
const briefFile = arg("--brief");
const metadata: Record<string, unknown> = {};
if (briefFile && existsSync(resolve(briefFile))) {
  try {
    metadata.brief = JSON.parse(readFileSync(resolve(briefFile), "utf8"));
  } catch (error) {
    console.error(`--brief 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
const productName = arg("--product").trim();
/**
 * 商品锚点的 metadata 形状以分流器为准（`productFromMetadata`）：
 * 优先 `dataMining.name`（情报档案），其次 `brief.product`（字符串 + `brief.brand.name`），
 * 再次 `products[]`（{name, brand}）。CLI 用最后一种——最不容易写错。
 */
if (productName) {
  metadata.products = [{ name: productName, brand: arg("--brand").trim() || undefined, category: arg("--category").trim() || undefined }];
}

/** LLM 仲裁（可选）：只在规则判不准时调用；密钥缺失即纯规则（不静默失败，只降级并在输出里写明） */
let llmCall: ((prompt: string) => Promise<string>) | undefined;
let llmNote = "未启用（纯规则）";
if (flag("--llm")) {
  const envFile = arg("--keys-file", join(homedir(), ".workloom/live.env"));
  const env: Record<string, string> = {};
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && match[2]!.trim()) env[match[1]!] = match[2]!.trim();
    }
  }
  const key = process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY;
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || "deepseek-chat";
  if (!key) {
    llmNote = `未启用（${envFile} 里没有 DEEPSEEK_API_KEY → 降级为纯规则）`;
  } else {
    llmNote = `已启用（${model}）`;
    llmCall = async (prompt: string): Promise<string> => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0, response_format: { type: "json_object" } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return body.choices?.[0]?.message?.content ?? "";
    };
  }
}

const decision = await routeVideoPipeline({ text: title, metadata, explicit }, { llmCall, llmTimeoutMs: 20_000 });
const intent = buildPipelineIntent(title, { platform: arg("--platform") || undefined });

const commands: Record<VideoPipelineKind, string> = {
  marketing: [
    "# 营销片（含商品情报档案与 G1 门）：先确认商品锚点，再按片型跑分镜生成 + 完整后期",
    "pnpm exec tsx scripts/tools/full-chain-film.mts \\",
    "  --shots work/film/shotlist.json --project VID-XXXX \\",
    "  --work-dir work/vm-VID-XXXX --out work/out-VID-XXXX --brief work/film/brief.json \\",
    "  --route work/route.json \\",
    "  --keys-file ~/.workloom/live.env --platform 抖音 --fps 24 \\",
    "  --stages cine-kb,continuity,micromotion,spec,material-gen,videos,voice,compose,color,subtitle,bgm,cover,mux,master,deliver \\",
    "  --subtitle-mode both --review-policy off",
      "# 商品档案：work/film/library/products/<档案>；G-PROD1 会逐镜校验真实商品绑定",
  ].join("\n"),
  narrative: [
    "# 叙事片（通用）：同一条 film 引擎，但不要求商品情报层；分镜卡仍须过 25 字段规范（spec 阶段）",
    "pnpm exec tsx scripts/tools/full-chain-film.mts \\",
    "  --shots work/film/shotlist.json --project VID-XXXX \\",
    "  --work-dir work/vm-VID-XXXX --out work/out-VID-XXXX --brief work/film/brief.json \\",
    "  --route work/route.json \\",
    "  --keys-file ~/.workloom/live.env --platform 抖音 --fps 24 \\",
    "  --stages cine-kb,continuity,micromotion,spec,plates,videos,voice,compose,color,subtitle,bgm,cover,mux,master,deliver \\",
    "  --subtitle-mode both --review-policy off",
  ].join("\n"),
  explainer: [
    "# 口播解说片（图文成片，不跑逐镜生成）：一份口播稿 + 一条配音",
    "pnpm explainer:run -- --script var/scripts/<稿>.md --task-id <任务> --profile <音色档> \\",
    "  --host-portraits bundles/ai-video/library/characters/<角色>/portraits/<版本> --brand-product <品牌产品>",
  ].join("\n"),
};

const lines = [
  `需求原文：${title}`,
  describeRouteDecision(decision),
  `意图清理后：${intent}`,
  `LLM 仲裁：${llmNote}`,
  decision.product ? `商品锚点：${decision.product.name}${decision.product.brand ? `（${decision.product.brand}）` : ""}` : "商品锚点：无",
  decision.route === "clarify"
    ? `\n⚠ 判不准：先问用户（不要替用户花钱）\n  ${decision.clarify?.question ?? ""}\n  选项：${(decision.clarify?.options ?? []).map((option) => `${option.key}=${option.label}`).join(" / ")}`
    : `\n建议命令：\n${commands[decision.route as VideoPipelineKind]}`,
];
console.log(lines.join("\n"));

const outFile = arg("--out");
if (outFile) {
  writeFileSync(resolve(outFile), `${JSON.stringify({
    schemaVersion: "workloom.video-route-record/v1",
    at: new Date().toISOString(),
    title,
    cleanedIntent: intent,
    llm: llmNote,
    decision,
    recommendedCommand: decision.route === "clarify" ? null : commands[decision.route as VideoPipelineKind],
  }, null, 2)}\n`, "utf8");
  console.log(`\n分流记录：${resolve(outFile)}`);
}
