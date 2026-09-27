/**
 * explainer/project-builder.ts —— 工程目录装配器（数据 → 可渲染工程）· T-2026-0926-0008
 *
 * 目录契约（spec §5.3，实现期按真实 CLI 对齐）：
 * ```
 * var/talkcraft-jobs/<taskId>/
 * ├── audio/full.wav                # 配音（与成片音轨同一条）
 * ├── audio/timestamps.json         # 字级时间戳（vendor 同 schema）
 * ├── audio/asr-words.json          # ASR 词表（对齐留痕，可追溯）
 * ├── remotion/                     # ← explainer-template 复制 + 引擎卡 + 逐镜派生场景
 * │   ├── src/cards/<slug>.tsx      # 引擎卡原文（card_lint.py 的保真对象）
 * │   ├── src/scenes/<shotId>.tsx   # 逐镜派生（内容槽补丁后的卡）
 * │   ├── src/scenes/index.ts       # 桶文件（静态 import 图，Remotion 必需）
 * │   ├── src/timing.json           # 逐字时间（make_timing 契约）
 * │   ├── shots.json / beats.json / anchors.json / cues.json
 * │   ├── props.json                # Composition inputProps
 * │   ├── public/                   # 人物素材 / 图素材 / 音效（全部本地）
 * │   └── node_modules -> <engine>/runtime/node_modules
 * └── out/                           # segments / assembled / v1.mp4 / delivery.mp4
 * ```
 *
 * 纪律：
 *   - **幂等**：同一 jobDir 重复装配是覆盖写（断点续跑安全）；卡源码只在缺失时复制（保真，不被二次补丁污染）；
 *   - **不猜**：素材文件不存在即抛错；音效名不在采样库里即抛错（渲染期 404 是最贵的失败）。
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchCardSource } from "./card-registry.js";
import { engineDirOf, assertEngineReady } from "./engine.js";
import { deriveAnchors, deriveBeats } from "./shotbook.js";
import { explainerOutputSize, type ExplainerQuality, type ExplainerScript, type ExplainerShotbook, type SemanticsFile, type TimestampsFile } from "./types.js";

/** 模板目录（本仓 packages/video-studio/explainer-template） */
export function templateDirOf(): string {
  // apps/server/src/video/explainer → 仓库根 → packages/video-studio/explainer-template
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../../packages/video-studio/explainer-template");
}

export interface BuildProjectInput {
  jobDir: string;
  engineDir?: string;
  templateDir?: string;
  script: ExplainerScript;
  timestamps: TimestampsFile;
  semantics: SemanticsFile;
  shotbook: ExplainerShotbook;
  /** 配音绝对路径（会被复制成 audio/full.wav） */
  audioPath: string;
  aspect?: "9:16" | "16:9";
  quality?: ExplainerQuality;
  fps?: number;
  /** 人物素材：hostForm → 绝对路径（视频或静帧） */
  hostAssets?: Record<string, string>;
  /** 其它素材：绝对路径 → public 相对路径 */
  assets?: Array<{ from: string; to: string }>;
  /** 是否导出音效采样库（shotbook 里有 sfx 时自动开） */
  withSfx?: boolean;
  onLog?: (line: string) => void;
}

export interface BuildProjectResult {
  jobDir: string;
  remotionDir: string;
  propsPath: string;
  shotsPath: string;
  beatsPath: string;
  anchorsPath: string;
  cuesPath: string;
  hostSrcByShot: Record<string, string | null>;
  cards: string[];
  scenes: string[];
  sfxFiles: string[];
}

export function buildProject(input: BuildProjectInput): BuildProjectResult {
  const env = process.env;
  const engineDir = input.engineDir ?? engineDirOf(env);
  const templateDir = input.templateDir ?? templateDirOf();
  const log = input.onLog ?? (() => undefined);
  assertEngineReady(engineDir, env);
  if (!existsSync(templateDir)) throw new Error(`模板目录不存在：${templateDir}`);
  const fps = input.fps ?? 30;
  const aspect = input.aspect ?? "9:16";
  const quality = input.quality ?? "hd";
  const { width, height } = explainerOutputSize(aspect, quality);

  const remotionDir = join(input.jobDir, "remotion");
  mkdirSync(join(input.jobDir, "audio"), { recursive: true });
  mkdirSync(join(input.jobDir, "out"), { recursive: true });

  /* ---------- ① 模板复制（保留目录结构；src/scenes 桶文件随后被覆盖） ---------- */
  copyTree(templateDir, remotionDir, { skip: ["node_modules", ".git"] });

  /* ---------- ② 音频与时间戳 ---------- */
  const audioTarget = join(input.jobDir, "audio", "full.wav");
  if (resolve(input.audioPath) !== resolve(audioTarget)) copyFileSync(input.audioPath, audioTarget);
  // 合成要能播到人声：Remotion 只吃 publicDir 下的静态资源 → 同一份配音在工程内再落一份
  const publicAudioDir = join(remotionDir, "public", "audio");
  mkdirSync(publicAudioDir, { recursive: true });
  copyFileSync(audioTarget, join(publicAudioDir, "full.wav"));
  writeFileSync(join(input.jobDir, "audio", "timestamps.json"), JSON.stringify(input.timestamps, null, 1));
  writeFileSync(
    join(input.jobDir, "audio", "script.json"),
    JSON.stringify({ sentences: input.script.sentences.map((s) => s.text) }, null, 1),
  );
  writeFileSync(join(remotionDir, "src", "timing.json"), JSON.stringify({ chars: timingCharsOf(input.timestamps, fps) }));

  /* ---------- ③ 卡原文 + 逐镜派生场景 ---------- */
  const cardsDir = join(remotionDir, "src", "cards");
  const scenesDir = join(remotionDir, "src", "scenes");
  mkdirSync(cardsDir, { recursive: true });
  mkdirSync(scenesDir, { recursive: true });
  const scenes: string[] = [];
  const cards: string[] = [];
  for (const shot of input.shotbook.shots) {
    const cardPath = join(engineDir, "template/cards", `${shot.card}.tsx`);
    if (!existsSync(cardPath)) throw new Error(`卡源码缺失：${cardPath}（shotbook 里的卡必须在引擎里存在）`);
    const canonical = join(cardsDir, `${shot.card}.tsx`);
    if (!existsSync(canonical)) {
      copyFileSync(cardPath, canonical);
    }
    // 用卡清单必须**无条件**登记（不是"本次新复制的"）：card_lint 要拿它做逐卡保真核验，
    // 复跑时若只登记新卡，闸会收到空清单并判"工程里没有 src/cards/*.tsx"（真机踩过）。
    cards.push(shot.card);
    const patched = patchCardSource(readFileSync(cardPath, "utf8"), { consts: shot.content, replaces: shot.replace });
    const sceneFile = join(scenesDir, `${shot.id}.tsx`);
    writeFileSync(sceneFile, sceneHeader(shot.id, shot.card, patched.applied) + patched.source);
    scenes.push(shot.id);
    if (shot.replace.length || Object.keys(shot.content).length) {
      log(`[builder] ${shot.id} ← 卡 ${shot.card}（补丁：${patched.applied.join("、")}）`);
    }
  }
  writeFileSync(join(scenesDir, "index.ts"), scenesBarrel(input.shotbook.shots.map((s) => s.id)));

  /* ---------- ④ 素材：人物 + 图 + 音效 ---------- */
  const publicDir = join(remotionDir, "public");
  mkdirSync(publicDir, { recursive: true });
  const hostSrcByShot: Record<string, string | null> = {};
  for (const shot of input.shotbook.shots) {
    const form = rhythmHostForm(input.shotbook, shot.id) ?? "无人物";
    hostSrcByShot[shot.id] = hostForForm(form, input.hostAssets ?? {}, publicDir, log);
  }
  // 同一 hostForm 只拷一次（多镜复用同一素材，避免工程膨胀）
  for (const { from, to } of input.assets ?? []) {
    const target = join(publicDir, to);
    if (!existsSync(from)) throw new Error(`素材不存在：${from}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(from, target);
  }

  const cues: Array<{ t: number; src: string; vol: number }> = [];
  const sfxFiles: string[] = [];
  for (const shot of input.shotbook.shots) {
    for (const cue of shot.sfx) {
      const rel = `sfx/${cue.name.replace(/^pk:/, "pk-")}.mp3`;
      cues.push({ t: Math.round(cue.t * 1000) / 1000, src: rel, vol: Math.min(0.35, cue.vol) });
    }
  }
  if (cues.length > 0 || input.withSfx) {
    const out = join(publicDir, "sfx");
    mkdirSync(out, { recursive: true });
    const code = spawnSyncNode(join(engineDir, "scripts/sfx_dump.mjs"), [out], log);
    if (code !== 0) throw new Error(`sfx_dump.mjs 失败（退出码 ${code}）：音效库未导出`);
    sfxFiles.push(...readdirSync(out));
    for (const cue of cues) {
      if (!sfxFiles.includes(basename(cue.src))) {
        throw new Error(`音效采样 ${cue.src} 不在引擎采样库里（可用：${sfxFiles.slice(0, 8).join("、")}…）——写错名字渲染期会 404`);
      }
    }
  }

  /**
   * sources.md（素材来源台账）：引擎 preflight 对"每条素材都要登记来源/授权"的硬规，
   * 本机人物底板与音效库都是**随仓资产**，这里如实登记它们的来源与授权口径
   * （写不出来源的素材不允许进片——这条不是形式主义，是 preflight 判 FAIL 的依据）。
   */
  writeFileSync(join(input.jobDir, "sources.md"), [
    "# 素材来源台账（project-builder 生成）",
    "",
    "| 素材 | 类型 | 来源 | 授权口径 |",
    "|---|---|---|---|",
    ...Object.entries(input.hostAssets ?? {}).map(([form, absPath]) =>
      `| host/${basename(absPath)}（${form}） | 人物底板（定妆照驱动） | 本仓角色档案 model-01-chen-zhuo（bundles/ai-video/library/characters） | 产品所有者授权角色档案；合成人脸，非真人素材 |`),
    cues.length > 0
      ? "| public/sfx/*.mp3 | 音效采样 | video-talkcraft 内嵌采样（demos/_lib/sfx-samples.js） | Mixkit Sound Effects Free License（免署名可商用，见 demos/_lib/sfx/ATTRIBUTION.md） |"
      : "",
  ].filter(Boolean).join("\n") + "\n");

  /* ---------- ⑤ 分镜表 / 节拍 / 锚点 / props ---------- */
  /**
   * 末镜对齐配音总长（T-2026-0926-0008 实现期修正）：
   * render_shots.mjs 会断言「shots.json 末镜 end 帧数 == composition.durationInFrames（差 ≤1 帧）」，
   * 而配音尾部通常有 0.1–0.5s 留白（TTS 尾音/气口），末句 end 往往略早于音频总长 ——
   * 不补齐就会以"分镜表与合成不同源"直接 FAIL。补齐后末镜多出的部分是收尾定格（内容不动，相机继续推）。
   */
  const lastId = input.shotbook.shots[input.shotbook.shots.length - 1]?.id;
  const shots = input.shotbook.shots.map((shot) => ({
    id: shot.id,
    start: shot.start,
    end: shot.id === lastId ? Math.max(shot.end, input.timestamps.total) : shot.end,
  }));
  const endById = new Map(shots.map((s) => [s.id, s.end]));
  const beats = deriveBeats(input.shotbook, input.timestamps, input.semantics);
  const anchors = deriveAnchors(beats, input.shotbook);
  /**
   * 锚点窗裁剪：竖屏/横屏各自给一条合法裁剪带（motion_check 的 DEFAULT_CROP 是 1200×120@(150,150)，
   * 按横屏宽幅版面写的——直接用在 1080 宽的竖屏上会以 "Invalid too big ... width 1200" 崩掉抖动闸）。
   * 这里给**画面下部信息带**（字幕之上、卡片之下），是静态文字最容易露抖动的位置。
   */
  const cropScale = quality === "uhd" ? 2 : 1;
  const cropBand = aspect === "9:16"
    ? `${1080 * cropScale}:${140 * cropScale}:0:${1500 * cropScale}`
    : `${1200 * cropScale}:${120 * cropScale}:${150 * cropScale}:${150 * cropScale}`;
  const anchorsWithCrop = anchors.map((a) => ({ ...a, crop: cropBand }));
  const shotsPath = join(remotionDir, "shots.json");
  const beatsPath = join(remotionDir, "beats.json");
  const anchorsPath = join(remotionDir, "anchors.json");
  const cuesPath = join(remotionDir, "cues.json");
  writeFileSync(shotsPath, JSON.stringify(shots, null, 1));
  writeFileSync(beatsPath, JSON.stringify(beats, null, 1));
  writeFileSync(anchorsPath, JSON.stringify(anchorsWithCrop, null, 1));
  writeFileSync(cuesPath, JSON.stringify(cues, null, 1));

  const props = {
    fps,
    width,
    height,
    quality,
    total: input.timestamps.total,
    theme: {
      base: input.shotbook.style.palette.base,
      accent: input.shotbook.style.palette.accent,
      ink: input.shotbook.style.palette.ink,
      font: input.shotbook.style.font,
      energy: input.shotbook.style.energy,
      product: input.shotbook.style.domain,
    },
    sentences: input.timestamps.sentences.map((s) => ({ i: s.i, text: s.text, start: s.start, end: s.end })),
    shots: input.shotbook.shots.map((shot) => ({
      id: shot.id,
      start: shot.start,
      end: endById.get(shot.id) ?? shot.end,
      card: shot.card,
      hostForm: rhythmHostForm(input.shotbook, shot.id) ?? "无人物",
      container: rhythmContainer(input.shotbook, shot.id) ?? "装框",
      hostSrc: hostSrcByShot[shot.id] ?? null,
      label: shotLabel(input.shotbook, shot.id),
    })),
    cues,
    voice: { src: "audio/full.wav", gain: 1 },
    debug: false,
  };
  const propsPath = join(remotionDir, "props.json");
  writeFileSync(propsPath, JSON.stringify(props, null, 1));
  /**
   * 纯音效轨 props（`sfxSolo`）：sfx_check 的"在场性"检查要一条只有音效、没有人声的 wav，
   * 由 `render_shots.mjs --audio out/sfx-solo.wav --props @props-sfx.json` 渲出（合成里 `sfxSolo` 会静默人声）。
   * 装配期就把它写好——QA 阶段再补文件会让"闸"依赖一个不存在的输入（真机踩过）。
   */
  writeFileSync(join(remotionDir, "props-sfx.json"), JSON.stringify({ ...props, voice: null, sfxSolo: true }, null, 1));
  writeFileSync(join(remotionDir, "overrides.json"), "{}\n");

  /* ---------- ⑥ 依赖软链 + 工程清单 ---------- */
  const runtimeModules = join(engineDir, "runtime", "node_modules");
  if (!existsSync(runtimeModules)) throw new Error(`引擎运行时依赖缺失：${runtimeModules}（先跑 pnpm talkcraft:install）`);
  linkNodeModules(remotionDir, runtimeModules);

  const manifest = {
    schema: "workloom.explainer-job/v1",
    jobDir: input.jobDir,
    aspect,
    quality,
    width,
    height,
    fps,
    total: input.timestamps.total,
    shots: shots.length,
    cards: [...new Set(input.shotbook.shots.map((s) => s.card))],
    withHost: Object.values(hostSrcByShot).filter(Boolean).length,
    audio: "audio/full.wav",
    props: "remotion/props.json",
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(input.jobDir, "job.json"), JSON.stringify(manifest, null, 1));
  return {
    jobDir: input.jobDir,
    remotionDir,
    propsPath,
    shotsPath,
    beatsPath,
    anchorsPath,
    cuesPath,
    hostSrcByShot,
    cards: [...new Set(cards)],
    scenes,
    sfxFiles,
  };
}

/* ================= 内部工具 ================= */

function timingCharsOf(timestamps: TimestampsFile, fps: number): Array<{ ch: string; t: number; e: number }> {
  void fps;
  const chars: Array<{ ch: string; t: number; e: number }> = [];
  for (const sentence of timestamps.sentences) {
    const tokens = sentence.words;
    let pos = 0;
    let previous = sentence.start;
    for (const ch of sentence.text.normalize("NFKC")) {
      const norm = ch.normalize("NFKC").toLowerCase();
      const countable = /[\u4e00-\u9fff a-z0-9]/i.test(norm) && !/[\s]/.test(norm);
      if (countable && pos < tokens.length) {
        const token = tokens[pos]!;
        pos += 1;
        previous = token.end;
        chars.push({ ch, t: round3(token.start), e: round3(token.end) });
      } else {
        chars.push({ ch, t: round3(previous), e: round3(previous) });
      }
    }
  }
  return chars;
}

function sceneHeader(shotId: string, card: string, applied: string[]): string {
  return [
    `// ⚠ 本文件由 project-builder 逐镜派生（shot=${shotId}，卡=${card}），不要手改：`,
    `//   卡原文见同工程 src/cards/${card}.tsx（card_lint.py 保真核验对象）；`,
    `//   内容补丁：${applied.length ? applied.join("、") : "无（保留 vendor 原文内容）"}。`,
    "",
  ].join("\n");
}

function scenesBarrel(ids: string[]): string {
  const imports = ids.map((id) => `import ${id} from "./${id}";`).join("\n");
  const entries = ids.map((id) => `${id}`).join(", ");
  return [
    "// ⚠ 由 project-builder 生成（静态依赖图，Remotion 必需）：不要手改。",
    'import React from "react";',
    imports,
    "",
    `export const SCENES: Record<string, React.FC> = { ${entries} };`,
    "",
  ].join("\n");
}

function rhythmHostForm(shotbook: ExplainerShotbook, shotId: string): string | null {
  return shotbook.rhythmTable.find((r) => r.shotId === shotId)?.hostForm ?? null;
}

function rhythmContainer(shotbook: ExplainerShotbook, shotId: string): string | null {
  return shotbook.rhythmTable.find((r) => r.shotId === shotId)?.container ?? null;
}

function shotLabel(shotbook: ExplainerShotbook, shotId: string): string {
  const index = shotbook.shots.findIndex((s) => s.id === shotId);
  const card = shotbook.shots[index]?.card ?? "";
  const total = String(shotbook.shots.length).padStart(2, "0");
  return `${shotbook.style.domain} · ${String(index + 1).padStart(2, "0")}/${total} · ${card}`;
}

function hostForForm(
  form: string,
  hostAssets: Record<string, string>,
  publicDir: string,
  log: (line: string) => void,
): string | null {
  if (form === "短离场" || form === "无人物") return null;
  const source = hostAssets[form] ?? hostAssets.default;
  if (!source) {
    log(`[builder] hostForm=${form} 但未提供人物素材 → 本形态无人物（shotbook 应改为短离场/无人物）`);
    return null;
  }
  if (!existsSync(source)) throw new Error(`人物素材不存在：${source}`);
  const target = join(publicDir, "host", basename(source));
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target)) copyFileSync(source, target);
  return `host/${basename(source)}`;
}

function linkNodeModules(projectDir: string, target: string): void {
  const link = join(projectDir, "node_modules");
  if (existsSync(link)) {
    try {
      rmSync(link, { recursive: true, force: true });
    } catch {
      // 目录非空且删不掉（Windows 句柄等）→ 交由下面的 symlinkSync 报错，不静默继续
    }
  }
  symlinkSync(target, link, "dir");
}

function copyTree(from: string, to: string, opts: { skip?: string[] } = {}): void {
  const skip = new Set(opts.skip ?? []);
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, opts);
    else if (entry.isFile()) copyFileSync(src, dst);
    else if (entry.isSymbolicLink() && statSync(src).isDirectory()) copyTree(src, dst, opts);
  }
}

function spawnSyncNode(script: string, args: string[], log: (line: string) => void): number {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  if (result.stdout) log(result.stdout.trim());
  if (result.stderr) log(result.stderr.trim());
  return result.status ?? -1;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
