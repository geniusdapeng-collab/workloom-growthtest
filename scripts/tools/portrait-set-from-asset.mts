#!/usr/bin/env tsx
/**
 * portrait-set-from-asset.mts —— **以认证真人素材为参考，一次生成整套多角度定妆照**
 *
 * 为什么是这条路（2026-09-30）：
 *   客户侧资产只以 `asset://` 存在（本地没有原图；平台 API 无"取资产内容"接口——实测 /assets/* 全 404；
 *   控制台里的私域人像库需要客户账号登录）。**不该让客户逐张导出**。而当初那张"有点像本人"的图，
 *   正是我们用 `asset://` 当参考跑生成得到的（见 `work/probe/render-sample.mjs` / `probe-asset.mjs`）——
 *   同一条路可以一次产出整套 8 角度，**客户零操作**。
 *
 * 用法：
 *   # 先干跑（不花钱）：打印逐角度提示词与将要发的请求
 *   pnpm exec tsx scripts/tools/portrait-set-from-asset.mts \
 *     --asset asset://asset-20260101000000-demo \
 *     --character demo-character --library work/film/library/characters \
 *     --out-dir work/film/library/characters/model-01-demo-character/portraits/_derived-src \
 *     --dry-run
 *
 *   # 充值后真跑（生成 → 落盘 → 自动调安装器写档案 + 复核）
 *   pnpm exec tsx scripts/tools/portrait-set-from-asset.mts ... --install --activate
 *
 * 纪律：
 *   1. **不伪造来源**：产物一律标注 `source=asset-derived`（派生定妆照，非权威原图）；
 *   2. **账户欠费即停**（403 AccountOverdueError）——不许"少几张也装"；
 *   3. 逐角度隔离：任一角度失败即整体失败（不装半套）；
 *   4. 同一张图被两个角度命中（模型偷懒）→ 拒绝；
 *   5. 装档与写后复核交给 `portrait-set-install.mts`（同一套校验与证据口径）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name: string): boolean => process.argv.includes(name);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALLER = join(REPO_ROOT, "scripts/tools/portrait-set-install.mts");
const DEFAULT_ANGLES = ["front", "threeQuarter", "closeup", "side", "frontFull", "threeQuarterLeft", "threeQuarterRight", "smileCloseup"];

/** 逐角度提示词：与角色档案的生成纪律同源（纯写实 + 中性背景/中性光 + 保留真实皮肤纹理） */
const ANGLE_PROMPTS: Record<string, string> = {
  front: "正面标准定妆照：人物正面直视镜头、肩线水平、双手自然垂放或交叠；",
  threeQuarter: "四分之三侧角定妆照：人物身体与面部约 45° 朝向镜头，露出两侧脸颊轮廓；",
  closeup: "面部近景定妆照：胸部以上近景，面部占据画面主体，眼神自然看向镜头；",
  side: "正侧面定妆照：人物 90° 正侧对镜头，完整呈现鼻梁、下颌与发型轮廓；",
  frontFull: "正全身定妆照：人物正面站立、全身入画、重心自然、双手放松；",
  threeQuarterLeft: "左侧四分之三定妆照：人物向画面右侧转身约 45°，左肩靠近镜头；",
  threeQuarterRight: "右侧四分之三定妆照：人物向画面左侧转身约 45°，右肩靠近镜头；",
  smileCloseup: "微笑近景定妆照：胸部以上近景，自然真诚的微笑，眼神看向镜头；",
};
const SKIN_AND_LIGHT = "写实商业人像摄影，干净中性背景（纯色影棚背幕）、柔和均匀中性光（约 5500K）、"
  + "白平衡中性；皮肤保留真实纹理与毛孔、不磨皮不美颜、不做网红滤镜；服装与发型保持与参考素材一致；"
  + "竖版 3:4 人像构图；无文字、无水印、无道具、无第二人。";

const assetRef = arg("--asset").trim();
const characterId = arg("--character").trim();
const libraryRoot = resolve(arg("--library", "work/film/library/characters"));
const assetId = assetRef.replace(/^asset:\/\//, "");
/**
 * **身份绑定语**（真机教训，2026-09-30）：只给 `reference_image` 而提示词不绑定身份时，
 * 模型会跑成"任意一个人"（实测：生成出一位穿汉服的陌生女性，与认证素材完全无关）。
 * 因此逐角度提示词必须以主档属性 + "与参考素材为同一人"开头——这是像不像的前提。
 */
const identityBinding = (() => {
  const profileFile = join(REPO_ROOT, "bundles/ai-video/library/real-person-assets", assetId, "profile.json");
  if (!existsSync(profileFile)) return "与参考素材中的同一人（面孔、发型与身份完全一致，不得换人）：";
  try {
    const profile = JSON.parse(readFileSync(profileFile, "utf8")) as {
      displayName?: string;
      certified?: { gender?: string; ageBand?: string; hair?: string; appearance?: string; wardrobeBaseline?: string };
    };
    const certified = profile.certified ?? {};
    const who = certified.gender === "female" ? "东亚女性" : certified.gender === "male" ? "东亚男性" : "同一人物";
    return `与参考素材中的同一人（${who}，${certified.ageBand ?? "年龄段以素材为准"}，`
      + `${certified.hair ?? "发型与参考素材一致"}，${certified.wardrobeBaseline ?? "服装与参考素材一致"}）；`
      + `面孔、五官比例、脸型、发型与身份必须与参考素材完全一致——不得换人、不得改年龄、不得改发型；`
      + `服装必须为现代商务造型：${certified.wardrobeBaseline ?? "与参考素材一致的高定套装"}＋珍珠耳饰；`
      + `**严禁**古装、汉服、旗袍、影楼写真服饰、发簪头饰、折扇等道具；背景为现代影棚纯色背幕；`;
  } catch {
    return "与参考素材中的同一人（面孔、发型与身份完全一致，不得换人）：";
  }
})();

/**
 * **多参考图**（2026-09-30 修正，产品所有者口径）：
 * 认证素材是**一组 11 张**（主素材 + 10 张同组，含不同角度）——不能"用一张正面照派生 8 张"。
 * 正确用法：每个目标角度都以「**该角度对应的那张**（若档案里有映射）＋ 主素材 ＋ 同组若干张」为参考一起提交，
 * 让模型拿到多视角的同一人信息；这也是管线里 `referenceAssetRefs(主素材 + 同组 2 张)` 的口径。
 */
const assetProfile = (() => {
  const profileFile = join(REPO_ROOT, "bundles/ai-video/library/real-person-assets", assetId, "profile.json");
  if (!existsSync(profileFile)) return null;
  try {
    return JSON.parse(readFileSync(profileFile, "utf8")) as {
      assetId?: string;
      referenceAssets?: string[];
      portraitSet?: { assets?: Array<{ assetId?: string; angleGuess?: string }> };
      notes?: string[];
    };
  } catch {
    return null;
  }
})();
const angleAssetMap: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const entry of assetProfile?.portraitSet?.assets ?? []) {
    const guess = entry.angleGuess ?? "";
    const id = entry.assetId ?? "";
    if (!id) continue;
    for (const angle of Object.keys(ANGLE_PROMPTS)) {
      if (guess.includes(angle)) map[angle] = id;
    }
  }
  return map;
})();
const mainAssetId = assetProfile?.assetId ?? assetId;
const groupAssetIds = (assetProfile?.referenceAssets ?? []).filter((id) => id && id !== mainAssetId);
/** 平台实测已失效的 assetId（首次提交时从 400 `not found` 里解析，后续角度不再送） */
const invalidAssetRefs = new Set<string>();
/** 该角度的参考清单：角度专属那张 → 主素材 → 同组依次补齐（去重），上限 `--refs`（默认 3，最多 4） */
function refsForAngle(angle: string): string[] {
  const ordered = [angleAssetMap[angle], mainAssetId, ...groupAssetIds]
    .filter((id): id is string => Boolean(id) && !invalidAssetRefs.has(id));
  const unique = [...new Set(ordered)];
  const limit = Math.max(1, Math.min(4, Number(arg("--refs", "3")) || 3));
  return unique.slice(0, limit).map((id) => `asset://${id}`);
}
if (!assetRef || !/^asset:\/\/[A-Za-z0-9._-]+$/.test(assetRef)) {
  console.error("用法：portrait-set-from-asset.mts --asset asset://asset-xxxx --character <角色ID> --library <角色库> [--angles a,b,...] [--out-dir <目录>] [--dry-run] [--install --activate] [--keys-file ~/.workloom/live.env]");
  process.exit(2);
}
if (!characterId) {
  console.error("缺少 --character");
  process.exit(2);
}
const characterDir = join(libraryRoot, characterId);
if (!existsSync(join(characterDir, "profile.json"))) {
  console.error(`角色档案不存在：${join(characterDir, "profile.json")}`);
  process.exit(2);
}
const angles = (arg("--angles").trim() ? arg("--angles").split(",").map((value) => value.trim()) : DEFAULT_ANGLES).filter(Boolean);
for (const angle of angles) {
  if (!ANGLE_PROMPTS[angle]) {
    console.error(`未知角度：${angle}（可用：${Object.keys(ANGLE_PROMPTS).join(" / ")}）`);
    process.exit(2);
  }
}
const outDir = resolve(arg("--out-dir", join(characterDir, "portraits", "_derived-src")));
const dryRun = flag("--dry-run");
const doInstall = flag("--install");
const activate = flag("--activate");

/** 密钥（只进内存，不落盘、不打印） */
const keysFile = resolve(arg("--keys-file", join(homedir(), ".workloom/live.env")));
const env: Record<string, string> = {};
if (existsSync(keysFile)) {
  for (const line of readFileSync(keysFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && match[2]!.trim()) env[match[1]!] = match[2]!.trim();
  }
}
const apiKey = process.env.VOLCENGINE_ARK_API_KEY || env.VOLCENGINE_ARK_API_KEY;
const baseUrl = (process.env.ARK_BASE_URL || env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
const model = process.env.SEEDREAM_MODEL || env.SEEDREAM_MODEL || "doubao-seedream-4-0-250828";
if (!apiKey && !dryRun) {
  console.error(`缺少 VOLCENGINE_ARK_API_KEY（读 ${keysFile} 或环境变量）`);
  process.exit(2);
}

const plan = {
  schemaVersion: "workloom.portrait-derived-plan/v1",
  at: new Date().toISOString(),
  assetRef, characterId, model, endpoint: `${baseUrl}/images/generations`, outDir,
  identityBinding,
  angles: angles.map((angle) => ({
    angle,
    prompt: `${identityBinding}${ANGLE_PROMPTS[angle]}${SKIN_AND_LIGHT}`,
    refs: refsForAngle(angle),
  })),
  source: "asset-derived",
  discipline: "派生定妆照（合成，非权威原图）：仅用于生成锚定；权威 likeness 以平台认证素材为准",
};
console.log(`计划：以 ${assetRef} 为参考生成 ${angles.length} 个角度（模型 ${model}）`);
console.log(`多参考图：主素材 ${mainAssetId} + 同组 ${groupAssetIds.length} 张（每个角度按 --refs 取 3–4 张一起提交）`);
for (const entry of plan.angles) {
  console.log(`  ${entry.angle.padEnd(18)} refs=${entry.refs.length} 张（${entry.refs.map((ref) => ref.split("-").pop()).join("/")}）`);
}
if (dryRun) {
  console.log(`\n（dry-run：未调用模型。逐角度完整提示词见下方 JSON；充值后去掉 --dry-run 即真跑）`);
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
/**
 * **自动像不像校验**（产品所有者口径：不能指望客户/人工确认）：
 * `--verify-against <已通过验收的成片帧>` 作为"事实锚"，逐张送评审模型判"是不是同一个人"
 * （只看人：面孔/五官比例/脸型/发型/年龄段；服装差异不影响判定）。未过即整批失败。
 */
const verifyAgainst = arg("--verify-against").trim();
/**
 * 校验模型必须用**仓内监制同款**配置（`LLM_*` 优先）：
 * `~/.workloom/live.env` 里的 `DEEPSEEK_BASE_URL` 指向的是 **anthropic 兼容端点**
 * （`https://api.deepseek.com/anthropic`），拿它拼 `/chat/completions` 会 404 —— 真机踩过：
 * 校验全判"失败"，看起来像"生成的图不像"，其实是校验通道写错了。
 */
const judgeKey = process.env.LLM_API_KEY || env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || "";
const judgeBase = (process.env.LLM_BASE_URL || env.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const judgeModel = process.env.LLM_MODEL || env.LLM_MODEL || process.env.DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || "deepseek-flash";
const verifyAnchorDataUrl = verifyAgainst && existsSync(resolve(verifyAgainst))
  ? `data:image/jpeg;base64,${readFileSync((() => {
    const prepared = join(outDir, ".verify-anchor.jpg");
    execFileSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-i", resolve(verifyAgainst),
      "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", prepared]);
    return prepared;
  })()).toString("base64")}`
  : null;
if (verifyAgainst && !verifyAnchorDataUrl) {
  console.error(`--verify-against 不存在：${verifyAgainst}`);
  process.exit(2);
}
if (verifyAnchorDataUrl && !judgeKey) {
  console.error("要做自动像不像校验，需要 DEEPSEEK_API_KEY（读 keys-file 或环境变量）");
  process.exit(2);
}
async function likenessCheck(png: Buffer, angle: string): Promise<{ ok: boolean; same: boolean; score: number | null; reason: string }> {
  if (!verifyAnchorDataUrl) return { ok: true, same: true, score: null, reason: "未启用自动校验（--verify-against 未提供）" };
  const imageDataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const response = await fetch(`${judgeBase}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${judgeKey}` },
    body: JSON.stringify({
      model: judgeModel, temperature: 0,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "图1 = 已通过验收的成片帧（认证真人的事实锚）；图2 = 新生成的定妆照。"
            + "只判\"是不是同一个人\"：看面孔五官比例、脸型、发型与年龄段；**服装/背景/光线差异不影响判定**。"
            + `只输出 JSON：{"same":true|false,"score":0-100,"reason":"一句话"}。当前角度：${angle}` },
          { type: "image_url", image_url: { url: verifyAnchorDataUrl } },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, same: false, score: null, reason: `校验模型调用失败 HTTP ${response.status}：${text.slice(0, 160)}` };
  try {
    const raw = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim()) as { same?: boolean; score?: number; reason?: string };
    const score = Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : null;
    const same = parsed.same === true && (score === null || score >= 70);
    return { ok: same, same: parsed.same === true, score, reason: String(parsed.reason ?? "").slice(0, 200) };
  } catch {
    return { ok: false, same: false, score: null, reason: `校验结论结构非法：${text.slice(0, 160)}` };
  }
}
const perAngle: Array<{ angle: string; file: string; sha256: string; bytes: number; refs: string[]; likeness: { ok: boolean; same: boolean; score: number | null; reason: string } }> = [];
/**
 * 两条引擎（`--engine auto|image|video`）：
 *   · image：`/images/generations` + `image: asset://…`（若平台在该端点支持 asset 参考，最快最省）；
 *   · video：`/contents/generations/tasks` + `image_url.url=asset://… & role=reference_image`（**已实测可用**，
 *     当初那张"像本人"的关键帧就是这条路的产物）→ 取视频首帧当定妆照。
 *   · auto（默认）：先 image，遇到"该端点不支持 asset 参考"这类 4xx 再退 video；**欠费(403)立刻整体失败**。
 */
const engineArg = arg("--engine", "two-stage").trim();
/**
 * `--anchor-image <本地图>`：图端点**不接受 `asset://`**（实测 400），但接受本地图（base64 data URL）。
 * 因此标准两段式是：① 用视频端点 + asset 参考出**一张**正面（或复用已有的一张）；
 * ② 以这张为锚点走图端点 img2img 出其余角度（更便宜、分辨率更高、脸部更稳）。
 */
const anchorImage = arg("--anchor-image").trim();
let anchorDataUrl: string | null = null;
if (anchorImage) {
  const file = resolve(anchorImage);
  if (!existsSync(file)) {
    console.error(`--anchor-image 不存在：${file}`);
    process.exit(2);
  }
  /**
   * 锚点必须**压到可发包**再送：真机实测 5.9MB PNG 直接 base64（≈8MB）会被端点拒/断连（`fetch failed`）。
   * 统一转 JPEG、最长边 ≤1536、质量 3 —— 对"锁脸+锁服装"足够，且把请求体压到几百 KB。
   */
  const prepared = join(outDir, ".anchor-input.jpg");
  mkdirSync(outDir, { recursive: true });
  execFileSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-i", file,
    "-vf", "scale='min(1536,iw)':-2", "-q:v", "3", prepared]);
  anchorDataUrl = `data:image/jpeg;base64,${readFileSync(prepared).toString("base64")}`;
}
if (!["two-stage", "auto", "image", "video"].includes(engineArg)) {
  console.error(`--engine 只支持 two-stage（默认：视频出身份母版 + 图生图出其余角度）/ auto / image / video，收到：${engineArg}`);
  process.exit(2);
}
const isOverdue = (text: string): boolean => /AccountOverdueError|overdue balance/i.test(text);

async function generateViaImage(prompt: string, referenceImages: string[] = []): Promise<Buffer> {
  /**
   * 图端点接受**本地图 / data URL**（也接受多张，见 `portrait-agent` 的 anchors 用法）；不接受 `asset://`。
   * `referenceImages` 为多图参考（身份母版）——多图比单图稳，但张数过多会稀释，2 张左右最佳。
   */
  const images = referenceImages.length > 0 ? referenceImages : (anchorDataUrl ? [anchorDataUrl] : [assetRef]);
  const requestBody = JSON.stringify({
    model, prompt, image: images.length === 1 ? images[0] : images,
    size: arg("--size", "2K"), response_format: "url", watermark: false,
  });
  /** 网络抖动（真机 `fetch failed` / ECONNRESET）重试 3 次（5s/15s 退避）；4xx/5xx 语义错误不重试 */
  let response: Response;
  let text: string;
  let lastError: unknown = null;
  response = undefined as unknown as Response;
  text = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: requestBody,
        signal: AbortSignal.timeout(300_000),
      });
      text = await response.text();
      break;
    } catch (error) {
      lastError = error;
      console.log(`  ↻ 图片端点第 ${attempt}/3 次网络失败（${error instanceof Error ? error.message.slice(0, 60) : String(error)}）`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 5_000 : 15_000));
    }
  }
  if (!response) throw lastError;
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} ${text.slice(0, 160)}`), { status: response.status, body: text });
  const body = JSON.parse(text) as { data?: Array<{ url?: string }> };
  const url = body.data?.[0]?.url ?? null;
  if (!url) throw new Error(`响应里没有图片 URL：${text.slice(0, 160)}`);
  return Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
}

/**
 * 视频路：**多参考图**提交 → 轮询 → 取首帧（frames:v 1）。
 *
 * **失效参考自动剔除**（2026-09-30 真机）：主档里的"同组 11 张"清单可能已经过期——
 * 实测 `asset-20260929120055-d6xr` 被平台判 `not found`。这里从 400 错误里解析出失效 assetId、
 * 把它从参考集里去掉后重试（失败提交不计费），并把被剔除的 ID 记进报告，供主档校正。
 */
async function generateViaVideo(prompt: string, refs: string[]): Promise<Buffer> {
  let activeRefs = [...refs];
  let submit: Response | null = null;
  let submitText = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    submit = await fetch(`${baseUrl}/contents/generations/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.SEEDANCE_MODEL || env.SEEDANCE_MODEL,
        content: [{ type: "text", text: `${prompt}（人物保持静止的定妆姿态，镜头固定不动）` },
          ...activeRefs.map((ref) => ({ type: "image_url", image_url: { url: ref }, role: "reference_image" }))],
        duration: Number(arg("--video-seconds", "4")), resolution: arg("--video-resolution", "1080p"),
        generate_audio: false, watermark: false, return_last_frame: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    submitText = await submit.text();
    if (submit.ok) break;
    const missing = /specified asset (asset-[A-Za-z0-9._-]+) is not found/.exec(submitText)?.[1];
    if (!missing || activeRefs.length <= 1) {
      throw Object.assign(new Error(`HTTP ${submit.status} ${submitText.slice(0, 200)}`), { status: submit.status, body: submitText });
    }
    invalidAssetRefs.add(missing);
    activeRefs = activeRefs.filter((ref) => !ref.includes(missing));
    console.log(`  ↻ 参考素材失效（${missing}）→ 剔除后重试（剩余 ${activeRefs.length} 张参考）`);
  }
  if (!submit?.ok) throw Object.assign(new Error(`HTTP ${submit?.status ?? "?"} ${submitText.slice(0, 200)}`), { status: submit?.status ?? 0, body: submitText });
  const taskId = (JSON.parse(submitText) as { id?: string }).id;
  if (!taskId) throw new Error(`提交响应里没有任务 ID：${submitText.slice(0, 160)}`);
  for (let i = 0; i < 36; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const poll = await fetch(`${baseUrl}/contents/generations/tasks/${taskId}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(60_000) });
    const pollText = await poll.text();
    const body = JSON.parse(pollText) as { status?: string; content?: { video_url?: string }; error?: unknown };
    if (body.status === "failed" || body.status === "cancelled") throw new Error(`视频任务失败：${pollText.slice(0, 200)}`);
    if (body.status !== "succeeded" || !body.content?.video_url) continue;
    const video = join(outDir, `.tmp-${taskId}.mp4`);
    writeFileSync(video, Buffer.from(await (await fetch(body.content.video_url, { signal: AbortSignal.timeout(180_000) })).arrayBuffer()));
    const frame = join(outDir, `.tmp-${taskId}.png`);
    execFileSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-ss", "0.4", "-i", video, "-frames:v", "1", frame]);
    return readFileSync(frame);
  }
  throw new Error("视频任务轮询超时（6 分钟）");
}

/** 把一张图压成"可发包"的 data URL（图端点单次请求体过大就 fetch failed，实测过） */
const dataUrlCache = new Map<string, string>();
async function toDataUrl(png: Buffer, tag: string): Promise<string> {
  const cached = dataUrlCache.get(tag);
  if (cached) return cached;
  const raw = join(outDir, `.ref-${tag}.png`);
  const small = join(outDir, `.ref-${tag}.jpg`);
  writeFileSync(raw, png);
  execFileSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-i", raw,
    "-vf", "scale='min(1536,iw)':-2", "-q:v", "3", small]);
  const url = `data:image/jpeg;base64,${readFileSync(small).toString("base64")}`;
  dataUrlCache.set(tag, url);
  return url;
}

/**
 * **两段式生产**（默认引擎，产品所有者口径：要"专业定妆照"、不要单图派生）：
 *   第一段：用 `asset://` 参考（视频路，唯一吃 asset 的入口）先出 1–2 张**身份母版**（默认 front，可加 threeQuarter）；
 *   第二段：以身份母版**多图**为参考走图端点 img2img（2K、便宜、专业布光），逐角度出图。
 * 任何一张不过"机器像不像"校验 → 单张回退视频路（asset 参考）重做一次；仍不过则整批拒绝。
 */
const stageAAngles = arg("--stage-a-angles", "front").split(",").map((value) => value.trim()).filter(Boolean);
const stageAMasters = new Map<string, Buffer>();
if (engineArg === "two-stage") {
  for (const angle of stageAAngles) {
    const entry = plan.angles.find((item) => item.angle === angle);
    if (!entry) continue;
    /**
     * 复用已生成的身份母版（`--reuse-masters`）：母版是最贵的一步（视频路），
     * 网络抖动/后续角度失败重跑时不该重复烧钱——文件在且没被改就继续用它。
     */
    const masterFile = join(outDir, `_master-${angle}.png`);
    if (flag("--reuse-masters") && existsSync(masterFile)) {
      const master = readFileSync(masterFile);
      stageAMasters.set(angle, master);
      console.log(`  ★ 复用已有身份母版 ${angle}：${masterFile}（${(master.byteLength / 1024).toFixed(0)}KB）`);
      continue;
    }
    const liveRefs = entry.refs.filter((ref) => !invalidAssetRefs.has(ref.replace(/^asset:\/\//, "")));
    console.log(`  ★ 身份母版 ${angle}：视频路 + ${liveRefs.length} 张 asset 参考（多参考=同一人多视角）`);
    const master = await generateViaVideo(entry.prompt, liveRefs);
    stageAMasters.set(angle, master);
    writeFileSync(masterFile, master);
    console.log(`    母版已存：${masterFile}（${(master.byteLength / 1024).toFixed(0)}KB）`);
  }
}
const masterDataUrls: string[] = [];
for (const [angle, master] of stageAMasters) masterDataUrls.push(await toDataUrl(master, `master-${angle}`));

for (const entry of plan.angles) {
  /** 参考集在每个角度开跑前重算：已确认失效的 assetId 不再送（避免每个角度都白试一次） */
  const liveRefs = entry.refs.filter((ref) => !invalidAssetRefs.has(ref.replace(/^asset:\/\//, "")));
  let image: Buffer;
  if (stageAMasters.has(entry.angle)) {
    image = stageAMasters.get(entry.angle)!;
  } else if (engineArg === "two-stage") {
    image = await generateViaImage(entry.prompt, masterDataUrls);
  } else if (engineArg === "video") {
    image = await generateViaVideo(entry.prompt, liveRefs);
  } else {
    try {
      image = await generateViaImage(entry.prompt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const body = (error as { body?: string }).body ?? "";
      if (isOverdue(detail) || isOverdue(body)) {
        console.error(`${entry.angle}：账户欠费（AccountOverdueError）→ 整体失败，先充值再重跑（本轮不产出任何文件、不做部分安装）`);
        process.exit(3);
      }
      if (engineArg === "image") {
        console.error(`${entry.angle}：图片端点失败 —— ${detail}`);
        process.exit(3);
      }
      console.log(`  ↻ ${entry.angle}：图片端点不可用（${detail.slice(0, 90)}）→ 退到视频路（asset 参考已实测可用）`);
      image = await generateViaVideo(entry.prompt, liveRefs);
    }
  }
  if (image.byteLength < 50_000) {
    console.error(`${entry.angle}：返回图过小（${image.byteLength} 字节），疑似失败页`);
    process.exit(3);
  }
  const file = join(outDir, `${characterId}-${entry.angle}.png`);
  writeFileSync(file, image);
  let likeness = await likenessCheck(image, entry.angle);
  /** 两段式下若图生图不像 → 单张回退视频路（asset 参考）重做一次；仍不过就保持失败（整批会拒绝） */
  if (!likeness.ok && engineArg === "two-stage" && !stageAMasters.has(entry.angle)) {
    console.log(`  ↻ ${entry.angle} 像不像未过（${likeness.reason.slice(0, 60)}）→ 回退视频路（asset 参考）重做一次`);
    image = await generateViaVideo(entry.prompt, liveRefs);
    writeFileSync(file, image);
    likeness = await likenessCheck(image, entry.angle);
  }
  perAngle.push({
    angle: entry.angle, file, sha256: createHash("sha256").update(image).digest("hex"),
    bytes: image.byteLength, refs: entry.refs, likeness,
  });
  console.log(`  ${likeness.ok ? "✓" : "✗"} ${entry.angle} → ${file}（${(image.byteLength / 1024).toFixed(0)}KB）`
    + ` 像不像：${likeness.same ? "同一人" : "疑似不一致"}${likeness.score === null ? "" : `（score ${likeness.score}）`} ${likeness.reason.slice(0, 60)}`);
}

/** 自动校验未过的角度一律不许装（宁缺毋滥：一套里混进不像的图比没有更糟） */
const failedLikeness = perAngle.filter((entry) => !entry.likeness.ok);
if (failedLikeness.length > 0) {
  console.error(`\n以下角度未过自动像不像校验，整批拒绝（不安装）：`);
  for (const entry of failedLikeness) console.error(`  ${entry.angle}：${entry.likeness.reason}`);
  console.error("修法：调提示词/参考图组合重跑（角度提示词或 --refs 数），或换 --verify-against 锚帧。");
  process.exit(2);
}

/** 模型偷懒防线：两个角度拿到同一张图 → 整套拒绝 */
const byHash = new Map<string, string[]>();
for (const entry of perAngle) byHash.set(entry.sha256, [...(byHash.get(entry.sha256) ?? []), entry.angle]);
const duplicated = [...byHash.entries()].filter(([, list]) => list.length > 1);
if (duplicated.length > 0) {
  console.error(`生成结果里有重复图（同一张被指到多个角度）：${duplicated.map(([, list]) => list.join("+")).join("，")} → 整套拒绝`);
  process.exit(2);
}

const mappingFile = join(outDir, "mapping.json");
writeFileSync(mappingFile, `${JSON.stringify(Object.fromEntries(perAngle.map((entry) => [entry.angle, `${characterId}-${entry.angle}.png`])), null, 2)}\n`, "utf8");
writeFileSync(join(outDir, "derived-plan.json"), `${JSON.stringify({ ...plan, perAngle }, null, 2)}\n`, "utf8");
console.log(`\n已产出 ${perAngle.length} 张派生定妆照：${outDir}`);

if (doInstall) {
  console.log("→ 调用安装器写档案并复核…");
  execFileSync(process.execPath, ["--import", "tsx", INSTALLER,
    "--character", characterId, "--library", libraryRoot, "--from", outDir, "--mapping", mappingFile,
    "--source", "asset-derived", ...(activate ? ["--activate"] : []),
  ], { stdio: "inherit" });
} else {
  console.log(`（未安装：加 --install 一步写入档案；或手工跑 portrait-set-install.mts --from ${outDir} --mapping ${mappingFile} --source asset-derived --activate）`);
}
