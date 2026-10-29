#!/usr/bin/env node
/**
 * portrait-agent CLI —— 定妆照生成 Agent（绑定角色档案）
 *
 * 用法：
 *   node scripts/tools/portrait-agent.mts plan --character <characterId>          # 只打印提示词（dry-run）
 *   node scripts/tools/portrait-agent.mts run  --character <characterId> [--seed 20260925]
 *        [--version 3] [--angles front,threeQuarter,closeup,side] [--no-activate]
 *        [--anchor <角色目录相对路径或绝对路径，可逗号分隔；也可给目录>]
 *   node scripts/tools/portrait-agent.mts review --character <characterId> [--version N] [--anchor <参考照片>]
 *        [--min-score 88] [--batch-size 12]
 *        # 机器监制评审（T-2026-1001-0007 起仅留证，不参与放行、不触发重做）：判断"是不是同一个人"
 *        # 成套定妆照默认一批看完（batch-size 12）：切批会让"同一人"这个整批判据被切碎
 *   node scripts/tools/portrait-agent.mts accept --character <characterId> [--version N]
 *        --by "<验收人>" --note "<依据/原话>" [--min-likeness 80]
 *        # 所有者验收：逐角度 1:1 机器像不像实测 + 所有者验收，两条并列留痕；门记录 via=owner-acceptance
 *   node scripts/tools/portrait-agent.mts reject --character <characterId> [--version N]
 *        --by "<验收人>" --note "<拒绝原因，至少8字>"
 *        # 追加当前版本的人类否决，不调用模型，不改档案或删除候选
 *
 * 纪律：纯写实 + 场景解耦（中性背景/中性光，只描述人）；默认 4 角度；产物写回档案库并置 active。
 * 授权真人：`--anchor` 给定本人照片即走图生图（source=img2img），锁面部与身形；不给则纯文生图。
 * 设计见 `docs/character-archive-design.md`（附录 A.1/A.2）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendGateEvent, assertCharacterComponent, buildGateEvent, buildPortraitPlan, loadCharacterEntry, resolveProducerLlm,
  reviewStage, runPortraitAgent
} from "../../packages/video-studio/src/index.js";
import { OpenAiCompatibleProvider } from "../../packages/base/model-router/providers.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY_ROOT = resolve(REPO_ROOT, process.env.HR_CHARACTER_LIBRARY ?? "var/media/characters");

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}
const flag = (name: string): boolean => process.argv.includes(name);
const command = process.argv[2] ?? "";

/**
 * 密钥加载（2026-09-24 修复）：与 `full-chain-film.mts` 同口径——**先读仓库外密钥文件**
 * `~/.workloom/live.env`（VOLCENGINE_ARK_API_KEY / LLM_* 的真实位置），再读仓库 `.env`，
 * 最后让进程环境覆盖。早先这里只读仓库 `.env`，于是 `portrait-agent review` 在真机上
 * 永远拿不到评审模型（fail-closed 打回），定妆照评审实际从未跑成过。
 */
const ENV: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const files = command === "reject" || command === "accept" && !flag("--with-likeness") || command === "plan" ? []
    : [arg("--keys-file") || resolve(homedir(), ".workloom", "live.env"), resolve(REPO_ROOT, ".env")];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && match[2]!.trim() && !out[match[1]!]) out[match[1]!] = match[2]!.trim();
    }
  }
  for (const [key, value] of Object.entries(process.env)) if (value) out[key] = value;
  return out;
})();

const characterId = arg("--character");

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/**
 * 锚点解析：支持（a）逗号分隔的文件列表、（b）目录（取其中全部图片，按文件名排序）、
 * （c）相对角色目录或相对仓库根。目录项 `sources/` 是真人照片的约定落点。
 */
function resolveAnchors(spec: string, characterDir: string): string[] {
  if (!spec) return [];
  const out: string[] = [];
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const candidates = [
      resolve(characterDir, raw),
      resolve(REPO_ROOT, raw),
      resolve(raw)
    ];
    const hit = candidates.find((p) => existsSync(p));
    if (!hit) throw new Error(`显式锚点不存在：${raw}，不能静默改成纯文生图`);
    const stat = statSync(hit);
    if (stat.isDirectory()) {
      for (const name of readdirSync(hit).sort()) {
        if (IMAGE_EXT.test(name)) out.push(join(hit, name));
      }
      continue;
    }
    out.push(hit);
  }
  if (out.length === 0) throw new Error("显式锚点目录没有图片，不能静默改成纯文生图");
  return out;
}

/**
 * 基准照片（身份锚）来源，按优先级：
 *   ① `--anchor a.jpg,b.jpg`（显式指定；真机踩过：以前 review 分支根本不读 --anchor → 永远是"无基准照片"）；
 *   ② 该版本 set 里登记的 `anchors`；
 *   ③ 角色目录 `sources/` 下的照片（installer 会把已验收成片帧拷到这里）。
 */
function anchorListFor(characterDir: string, target: { anchors?: string[] }, anchorSpec: string): string[] {
  const cliAnchors = anchorSpec ? resolveAnchors(anchorSpec, characterDir) : [];
  if (cliAnchors.length > 0) return cliAnchors;
  const registered = (target.anchors ?? []).map((p) => resolve(characterDir, p)).filter(existsSync);
  if (registered.length > 0) return registered;
  const sources = join(characterDir, "sources");
  return existsSync(sources)
    ? readdirSync(sources).filter((f) => IMAGE_EXT.test(f)).slice(0, 4).map((f) => join(sources, f))
    : [];
}

/** 送审图压缩（最长边 ≤1536 的 JPEG）：3–5MB 的 PNG 直接 base64 会被评审端点拒/断连 */
function toJudgeJpeg(file: string, tmpDir: string, name: string): string | null {
  const out = join(tmpDir, `${name}.jpg`);
  const bin = process.env.WL_FFMPEG ?? resolve(homedir(), ".workloom-color", "bin", "ffmpeg");
  const result = spawnSync(existsSync(bin) ? bin : "ffmpeg",
    ["-v", "error", "-y", "-i", file, "-vf", "scale='min(1536,iw)':-2", "-q:v", "3", out],
    { timeout: 120_000 });
  return result.status === 0 && existsSync(out) ? out : null;
}

const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

async function main(): Promise<void> {
  if (!characterId) {
    console.error("用法：portrait-agent.mts <plan|run> --character <characterId> [--seed N] [--version N] [--angles a,b] [--no-activate]");
    process.exitCode = 2;
    return;
  }
  assertCharacterComponent(characterId);
  for (const name of ["--character", "--seed", "--version", "--angles", "--anchor", "--size", "--wardrobe-id", "--wardrobe"]) {
    const value = arg(name);
    if (flag(name) && (!value || value.startsWith("--"))) throw new Error(`参数缺少值：${name}`);
  }
  const entry = loadCharacterEntry(join(LIBRARY_ROOT, characterId));
  if (!entry) {
    console.error(`未找到角色档案：${join(LIBRARY_ROOT, characterId, "profile.json")}`);
    process.exitCode = 1;
    return;
  }
  const model = ENV.ARK_IMAGE_MODEL || ENV.SEEDREAM_MODEL || "doubao-seedream-5-0-pro-260628";
  const config = {
    model, baseUrl: ENV.ARK_BASE_URL,
    ...(arg("--seed") ? { seed: Number(arg("--seed")) } : {}),
    ...(arg("--version") ? { version: Number(arg("--version")) } : {}),
    ...(arg("--angles") ? { angles: arg("--angles").split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(arg("--anchor") ? { anchorImages: resolveAnchors(arg("--anchor"), join(LIBRARY_ROOT, characterId)) } : {}),
    ...(arg("--size") ? { size: arg("--size") } : {}),
    ...(flag("--no-activate") ? { activate: false } : {}),
    ...(arg("--wardrobe-id") ? { wardrobeId: arg("--wardrobe-id") } : {}),
    ...(arg("--wardrobe") ? { wardrobe: { name: arg("--wardrobe") } } : {})
  };

  if (command === "plan") {
    const plan = buildPortraitPlan(entry, config);
    console.log(`角色：${plan.name}（${plan.characterId}）｜版本 v${plan.version}｜模式 ${plan.mode}（${plan.reason}）`);
    console.log(`锚点：${plan.anchors.length > 0 ? plan.anchors.map((f) => f.split("/").slice(-1)[0]).join(" / ") : "无（纯文生图）"}`);
    console.log(`角度：${plan.angles.join(" / ")}`);
    console.log(`服装：${String(plan.wardrobe.name ?? "未指定")}｜服装hash=${plan.wardrobeHash}｜请求hash=${plan.requestHash}`);
    if (plan.negativeTerms) console.log(`负面词：${plan.negativeTerms}`);
    for (const [angle, prompt] of Object.entries(plan.prompts)) console.log(`\n[${angle}]\n${prompt}`);
    return;
  }

  if (command === "run") {
    const apiKey = ENV.VOLCENGINE_ARK_API_KEY || ENV.ARK_API_KEY || process.env.VOLCENGINE_ARK_API_KEY || process.env.ARK_API_KEY || "";
    if (!apiKey) {
      console.error("缺少 ARK 密钥（.env: VOLCENGINE_ARK_API_KEY / ARK_API_KEY）");
      process.exitCode = 1;
      return;
    }
    const result = await runPortraitAgent({
      libraryRoot: LIBRARY_ROOT,
      characterId,
      apiKey,
      model,
      baseUrl: ENV.ARK_BASE_URL,
      config,
      log: (line) => console.log(line)
    });
    console.log(`\n${result.portraitSet.status === "ready" ? "已完成" : "候选未完整"}：${result.characterId} v${result.version} ${Object.keys(result.files).join("/")}`);
    console.log(`   档案：${result.profileFile}`);
    console.log(`   定妆照集：portrait-sets/v${result.version}.json（active=${result.portraitSet.active}）`);
    if (result.portraitSet.status !== "ready") process.exitCode = 4;
    return;
  }

  if (command === "review") {
    const characterDir = join(LIBRARY_ROOT, characterId);
    const versionArg = arg("--version") ? Number(arg("--version")) : null;
    const selected = loadCharacterEntry(characterDir, versionArg === null ? {} : { pinnedVersion: versionArg });
    const target = selected?.activeSet;
    if (!target) {
      console.error(`未找到定妆照集（version=${versionArg ?? "active"}）`);
      process.exitCode = 1;
      return;
    }
    if (selected!.verification.status !== "passed") throw new Error(`候选尚不可评审：${selected!.verification.issues.join("；")}`);
    const produced = Object.values(selected!.files);
    const fallbackAnchors = anchorListFor(characterDir, target, arg("--anchor"));
    const required = ["front", "threeQuarter", "closeup", "side"];
    const verdict = await reviewStage({
      stage: "keyframe",
      projectId: `portrait:${entry.id}:v${target.version}`,
      artifacts: produced.map((path) => ({ path, kind: "image" as const, bytes: statSync(path).size })),
      referenceImages: fallbackAnchors,
      deterministic: [
        { id: "required-angles", pass: required.every((a) => (target.angles ?? []).includes(a)), hard: true, detail: `必需角度 ${required.join("/")}；实际 ${(target.angles ?? []).join("/")}` },
        { id: "file-size", pass: produced.every((f) => statSync(f).size > 50_000), hard: true, detail: produced.map((f) => `${f.split("/").slice(-1)[0]}=${(statSync(f).size / 1024).toFixed(0)}KB`).join(" ") },
        { id: "anchor-present", pass: fallbackAnchors.length > 0, detail: fallbackAnchors.length > 0 ? `基准照片 ${fallbackAnchors.length} 张（可做人脸一致性比对）` : "无基准照片（无法判断像不像，仅能判画质与纪律）" }
      ],
      context: {
        characterId: entry.id,
        name: entry.name,
        kind: entry.kind,
        source: target.source,
        version: target.version,
        discipline: "定妆照口径（2026-10-01 客户口径修订）：**唯一硬标准是「人脸是真的」**——与基准照片为同一张脸（五官比例/眼型/鼻型/唇形/脸型）。"
          + "真实生活里同一个人本来就会有发型/发色/妆造/服装/配饰的变化，也可能佩戴品牌首饰衣物；"
          + "背景灰调、光位、景别差异属正常拍摄差异。"
          + "**因此：发型、发色、服装、配饰、品牌标识、背景色温/明度等一律不作为不合格理由**，最多作为咨询建议。"
          + "「没有实景/没有道具」也不是缺陷。",
        note: "评审要点：只看「是不是同一个人」。像不像的判据是五官比例/眼型/鼻型/唇形/脸型；"
          + "不要因为造型变化、品牌标识、背景灰调漂移而判不合格；缺基准照片或无法判断时才拒绝（缺证据不得猜测通过）。"
      },
      /** 身份阈值提高到 88（客户口径：人脸一定要真）——低于它宁可打回重出，也不要用"差不多"的锚图生成全片 */
      minScore: Number(arg("--min-score", "88")),
      /**
       * 成套评审必须**一批看完**（T-2026-1001-0006 真机事故）：8 张定妆照按默认 6 张/批切成 6+2，
       * 第二批只拿 2 张也要独立判"与基准是不是同一张脸"，导致同一份结论自相矛盾、分数取最小值 32。
       * 定妆照集最多 12 个角度，默认一批装下；图片仍受单张 900KB 与压缩预算保护。
       */
      batchSize: Number(arg("--batch-size", "12")),
      allowFallbackApprove: false,
      /**
       * 必须显式传 env（2026-09-24 真机）：`reviewStage` 缺省只读 `process.env`，
       * 而密钥在 `~/.workloom/live.env` 里 → 不传 env 就永远"无可用评审模型"，
       * 定妆照评审实际从未跑成（G5 门因此长期只有 degraded 记录）。
       */
      env: ENV,
      log: (line) => console.log(line)
    });
    const reviewDir = join(characterDir, "reviews");
    mkdirSync(reviewDir, { recursive: true });
    const reviewFile = join(reviewDir, `v${target.version}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reviewFile, `${JSON.stringify({ at: new Date().toISOString(), characterId: entry.id, version: target.version, source: target.source, verdict, artifacts: produced, references: fallbackAnchors }, null, 2)}\n`);
    /**
     * G5 门事件落账（2026-09-24）：定妆照确认门 `g5-portrait-confirm` 以前只有 review 文件，
     * 片场运行时（full-chain-film 的 G5）读不到"按 step_key 记账的门记录"，只能标 degraded。
     * 这里把评审结论写进角色目录的 `gates.jsonl`（与阶段日志同一门账本格式），供片场与平台按 step_key 检索。
     */
    const gateEvent = buildGateEvent({
      stepKey: "g5-portrait-confirm",
      projectId: `portrait:${entry.id}:v${target.version}`,
      sourceStage: "portrait-review",
      shotIds: [],
      checks: [
        { id: "required-angles", pass: required.every((a) => (target.angles ?? []).includes(a)), hard: true, detail: `必需角度 ${required.join("/")}；实际 ${(target.angles ?? []).join("/")}` },
        { id: "file-size", pass: produced.every((f) => statSync(f).size > 50_000), hard: true, detail: produced.map((f) => `${f.split("/").slice(-1)[0]}=${(statSync(f).size / 1024).toFixed(0)}KB`).join(" ") },
        { id: "anchor-present", pass: fallbackAnchors.length > 0, detail: fallbackAnchors.length > 0 ? `基准照片 ${fallbackAnchors.length} 张` : "无基准照片（人像同一性无法与真人比对，仅判画质与跨角度一致性）" }
      ],
      softApproved: verdict.approved,
      via: verdict.via,
      score: verdict.score,
      degraded: verdict.degraded,
      reason: `【机器留证·不参与放行】${verdict.reason}`,
      evidence: {
        reviewFile, artifacts: produced.length, references: fallbackAnchors.length, characterId: entry.id, version: target.version,
        /** T-2026-1001-0007：机器评审判据退出决策链，只作证据；放行请走 `accept`（via=owner-acceptance） */
        advisory: true, decisionPolicy: "machine-evidence-only", decisionOwner: "human",
      }
    });
    appendGateEvent(join(characterDir, "gates.jsonl"), gateEvent);
    console.log(`门记录（g5-portrait-confirm）：机器留证已写入（不参与放行）→ ${join(characterDir, "gates.jsonl")}`);
    console.log(`机器结论（仅留证，不决定放行/重做）：${verdict.approved ? "机器认为合格" : "机器认为不合格"}（score=${verdict.score} · via=${verdict.via}）`);
    console.log(`  理由：${verdict.reason}`);
    if (verdict.issues.length > 0) console.log(`  问题：${verdict.issues.join("；")}`);
    if (verdict.suggestions.length > 0) console.log(`  建议：${verdict.suggestions.join("；")}`);
    console.log(`  评审记录：${reviewFile}`);
    console.log(`  （T-2026-1001-0007：机器判据不触发重做；请人类看过原图后执行 accept 记录验收）`);
    return;
  }

  /**
   * `accept` —— **所有者验收**（owner-acceptance，T-2026-1001-0006）。
   *
   * 为什么需要这条通道：「像不像」这类判据，机器（生成器 1:1 像不像门 + 监制）会给出互相矛盾或低于阈值的分数，
   * 而产品所有者/客户本人是**唯一见过真人的裁判**。本命令把两件事并列留痕、谁也不冒充谁：
   *   ① 机器证据：逐角度 1:1 对基准照片的像不像分（重新实测，不引用旧结论）；
   *   ② 所有者验收：验收人 + 依据原话 + 时间（`--by` / `--note`，缺一即拒）。
   * 落账 `g5-portrait-confirm` 时 `via=owner-acceptance`（**不写成 llm/监制通过**），审计一眼可分辨。
   */
  if (command === "reject") {
    const rejectedBy = arg("--by").trim();
    const note = arg("--note").trim();
    if (!rejectedBy || note.length < 8) throw new Error("人类否决必须写明验收人（--by）和拒绝原因（--note，≥8 字）");
    const characterDir = join(LIBRARY_ROOT, characterId);
    const versionArg = arg("--version") ? Number(arg("--version")) : null;
    const selected = loadCharacterEntry(characterDir, versionArg === null ? {} : { pinnedVersion: versionArg });
    const target = selected?.activeSet;
    if (!target) throw new Error(`未找到要否决的定妆照版本（version=${versionArg ?? "active"}）`);
    const reviewDir = join(characterDir, "reviews");
    mkdirSync(reviewDir, { recursive: true });
    const receipt = join(reviewDir, `v${target.version}-owner-rejection-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const artifacts = Object.entries(selected!.files).map(([angle, file]) => ({ angle, file, sha256: existsSync(file) ? sha256File(file) : null }));
    writeFileSync(receipt, JSON.stringify({ at: new Date().toISOString(), characterId, version: target.version,
      kind: "owner-rejection", basis: "human-review", approved: false, rejectedBy, note, artifacts }, null, 2) + "\n");
    const event = buildGateEvent({ stepKey: "g5-portrait-confirm", projectId: `portrait:${characterId}:v${target.version}`,
      sourceStage: "owner-acceptance", shotIds: [], checks: [{ id: "owner-decision", pass: false, hard: true, detail: note }],
      softApproved: false, via: "owner-acceptance", score: null, reason: `人类验收否决：${rejectedBy}｜${note}`,
      evidence: { basis: "human-review", characterId, version: target.version, ownerRejection: receipt } });
    appendGateEvent(join(characterDir, "gates.jsonl"), event);
    console.log(`人类否决已记录（当前版本不放行）：${receipt}`);
    return;
  }
  if (command === "accept") {
    const characterDir = join(LIBRARY_ROOT, characterId);
    const versionArg = arg("--version") ? Number(arg("--version")) : null;
    const selected = loadCharacterEntry(characterDir, versionArg === null ? {} : { pinnedVersion: versionArg });
    const target = selected?.activeSet;
    if (!target) {
      console.error(`未找到定妆照集（version=${versionArg ?? "active"}）`);
      process.exitCode = 1;
      return;
    }
    if (selected!.verification.status !== "passed") throw new Error(`候选尚不可验收：${selected!.verification.issues.join("；")}`);
    const acceptedBy = arg("--by").trim();
    const note = arg("--note").trim();
    if (!acceptedBy || note.length < 8) {
      throw new Error("所有者验收必须写明验收人（--by）与依据（--note，≥8 字）：不接受「有人点过头」式的无凭放行");
    }
    const anchors = anchorListFor(characterDir, target, arg("--anchor"));
    if (anchors.length === 0) throw new Error("所有者验收缺基准照片（身份锚）：像不像无从比对，fail-closed");
    const anchor = anchors[0]!;
    /**
     * 机器像不像**默认不跑**（2026-10-01 产品所有者口径）：出图后的评审决策交给人类，
     * 机器判据不稳定（同一批文件实测 threeQuarterLeft 92↔15–86、threeQuarterRight 82↔12–20），
     * 拿它当闸门只会误杀或误放。需要留机器证据时显式 `--with-likeness`（结果只作记录，不参与裁决）。
     */
    const withLikeness = flag("--with-likeness");
    const minLikeness = Number(arg("--min-likeness", "80"));
    const perAngle: Array<{ angle: string; file: string; sha256: string; score: number | null; same: boolean; ok: boolean; reason: string }> = [];
    let likenessError: string | null = null;
    if (withLikeness) {
      if (!Number.isFinite(minLikeness) || minLikeness < 0 || minLikeness > 100) throw new Error("--min-likeness 非法（0–100）");
      const llm = resolveProducerLlm(ENV);
      if (!llm) throw new Error("--with-likeness 需要评审模型（LLM_BASE_URL / LLM_API_KEY 或 DEEPSEEK_*）");
      const provider = new OpenAiCompatibleProvider(llm.model, {
        baseUrl: llm.baseUrl,
        apiKey: llm.apiKey,
      });
      const tmpDir = mkdtempSync(join(homedir(), ".workloom-portrait-"));
      try {
        /** 基准同样压到可发包再送（真机：5.9MB PNG 直接 base64 会被端点拒或断连） */
        const anchorJpeg = toJudgeJpeg(anchor, tmpDir, "anchor") ?? anchor;
        const anchorMime = anchorJpeg.toLowerCase().endsWith(".png") ? "image/png" : anchorJpeg.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg";
        const anchorDataUrl = `data:${anchorMime};base64,${readFileSync(anchorJpeg).toString("base64")}`;
        console.log(`逐角度像不像实测（1:1 对基准，仅留证不裁决）：${anchor}`);
        for (const [angle, file] of Object.entries(selected!.files)) {
        const jpeg = toJudgeJpeg(file, tmpDir, angle);
        if (!jpeg) throw new Error(`送审图压缩失败：${file}`);
        const result = await provider.chat([{
              role: "user",
              content: [
                { type: "text", text: "图1 = 已通过验收的成片帧（认证真人的事实锚）；图2 = 定妆照候选。" +
                  "只判\"是不是同一个人\"：看面孔五官比例、脸型、年龄段；服装/背景/光线差异不影响判定。" +
                  `只输出 JSON：{"same":true|false,"score":0-100,"reason":"一句话"}。当前角度：${angle}` },
                { type: "image_url", image_url: { url: anchorDataUrl } },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${readFileSync(jpeg).toString("base64")}` } }
              ]
        }], {
          scene: "video.quality.plausibility-review",
          timeoutMs: 600_000,
          temperature: 0,
          retries: 0,
        });
        const parsed = JSON.parse(result.text.trim()) as { same?: boolean; score?: number; reason?: string };
        const score = Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : null;
        const same = parsed.same === true;
        const ok = same && (score === null || score >= minLikeness);
        perAngle.push({ angle, file, sha256: sha256File(file), score, same, ok, reason: String(parsed.reason ?? "").slice(0, 200) });
        console.log(`  ${ok ? "✓" : "✗"} ${angle}：${same ? "同一人" : "疑似不一致"}${score === null ? "" : `（${score}）`}`);
        }
      } catch (error) {
        likenessError = error instanceof Error ? error.message : String(error);
        console.log(`  ⚠ 机器像不像实测未完成：${likenessError}（不影响人类裁决）`);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
    const summary = {
      angles: perAngle.length,
      sameAngles: perAngle.filter((entry) => entry.same).length,
      minScore: perAngle.every((entry) => entry.score !== null) ? Math.min(...perAngle.map((entry) => entry.score as number)) : null,
      allSame: perAngle.every((entry) => entry.ok)
    };
    const belowThreshold = perAngle.filter((entry) => !entry.ok).map((entry) => `${entry.angle}(${entry.score ?? "n/a"})`);
    const reviewDir = join(characterDir, "reviews");
    mkdirSync(reviewDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const likenessFile = withLikeness ? join(reviewDir, `v${target.version}-likeness-${stamp}.json`) : null;
    if (likenessFile) {
      writeFileSync(likenessFile, `${JSON.stringify({
        at: new Date().toISOString(), characterId: entry.id, version: target.version, kind: "machine-likeness",
        note: "仅留证，不参与裁决（机器判据不稳定：同一批文件实测 92↔15–86 / 82↔12–20）",
        anchor: { file: anchor, sha256: sha256File(anchor) }, threshold: minLikeness, perAngle, summary, error: likenessError
      }, null, 2)}\n`, "utf8");
    }
    const artifacts = Object.entries(selected!.files).map(([angle, file]) => ({ angle, file, sha256: sha256File(file) }));
    const ownerFile = join(reviewDir, `v${target.version}-owner-acceptance-${stamp}.json`);
    writeFileSync(ownerFile, `${JSON.stringify({
      at: new Date().toISOString(), characterId: entry.id, version: target.version, kind: "owner-acceptance",
      /** 裁决口径：出图后的评审决策交给人类（产品所有者 2026-10-01）；机器判据不参与放行 */
      basis: "human-review",
      approved: true,
      acceptedBy, note,
      likenessReport: likenessFile,
      likeness: withLikeness ? { ...summary, belowThreshold, error: likenessError } : { status: "not-run", why: "机器判据不参与裁决（口径：评审决策交给人类）" },
      artifacts,
      anchors: anchors.map((file) => ({ file, sha256: sha256File(file) }))
    }, null, 2)}\n`, "utf8");
    const checks = [
      { id: "required-angles", pass: ["front", "threeQuarter", "closeup", "side"].every((a) => (target.angles ?? []).includes(a)), hard: true, detail: `实际角度 ${(target.angles ?? []).join("/")}` },
      { id: "file-size", pass: Object.values(selected!.files).every((f) => statSync(f).size > 50_000), hard: true, detail: `${Object.keys(selected!.files).length} 张均 >50KB` },
      { id: "anchor-present", pass: true, hard: true, detail: `基准照片 1 张（${anchor.split("/").slice(-1)[0]}，sha256 ${sha256File(anchor).slice(0, 12)}…）` },
      /** 形式判据：资产本身齐备（角度/体积/文件指纹），这些是事实项，不是质量裁决 */
      { id: "artifacts-present", pass: artifacts.every((item) => existsSync(item.file) && statSync(item.file).size > 50_000), hard: true, detail: `${artifacts.length} 张角度图齐备且已记指纹 sha256` },
      /** 裁决判据：**人类验收**（产品所有者/客户本人看过原图后的决定） */
      { id: "owner-acceptance", pass: true, hard: true, detail: `人类验收：${acceptedBy}｜依据：${note.slice(0, 120)}` }
    ];
    if (withLikeness) {
      checks.splice(4, 0, { id: "machine-likeness-evidence", pass: perAngle.length > 0, hard: false, detail: `机器像不像留证 ${perAngle.length} 个角度（不参与裁决）：最低分 ${summary.minScore ?? "n/a"}` });
    }
    const gateEvent = buildGateEvent({
      stepKey: "g5-portrait-confirm",
      projectId: `portrait:${entry.id}:v${target.version}`,
      sourceStage: "owner-acceptance",
      shotIds: [],
      checks,
      softApproved: true,
      via: "owner-acceptance",
      score: withLikeness ? summary.minScore : null,
      reason: `人类验收放行（via=owner-acceptance，非机器监制通过）：${acceptedBy} 看过原图后确认可用。`
        + `口径：出图后的评审决策交给人类，机器判据不参与放行`
        + (withLikeness ? `；机器证据仅留档（${summary.sameAngles}/${summary.angles} 判同一人，最低 ${summary.minScore ?? "n/a"}）` : ""),
      evidence: { likenessReport: likenessFile, ownerAcceptance: ownerFile, anchors, characterId: entry.id, version: target.version, basis: "human-review" }
    });
    appendGateEvent(join(characterDir, "gates.jsonl"), gateEvent);
    console.log(`\n门记录（g5-portrait-confirm）：${gateEvent.ok ? "放行" : "未过"}（via=owner-acceptance）`);
    if (likenessFile) console.log(`  机器像不像留证（不裁决）：${likenessFile}`);
    console.log(`  所有者验收记录：${ownerFile}`);
    return;
  }

  console.error(`未知子命令：${command}（可用：plan / run / review / accept / reject）`);
  process.exitCode = 2;
}

try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
