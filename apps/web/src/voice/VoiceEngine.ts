/**
 * VoiceEngine · 语音播报（端侧 speechSynthesis，零网络零密钥）
 *
 *  - Bundle 可显式覆盖音色；缺省按角色标识稳定散列到通用中文音色；
 *  - 优先级队列：fuse（熔断，立即打断）> ask（请示）> ceremony（仪式）> ambient；
 *  - 降级：speechSynthesis 不可用/无语音 → available=false，仅走字幕（SubBus）。
 *  - 字幕事件总线（SubBus）：所有播报（含仅字幕模式）同步发字幕，新闻台字幕条消费。
 *
 * [VOICE-DEFAULT] 织伴默认音色=本机克隆音色（工位不可用时回落系统女声）
 */
import { AudioEngine } from "../audio/AudioEngine";
import { neuralVoiceAvailable, neuralVoiceConfig, playNeuralSpeech, probeNeuralVoice, wantsNeuralVoice } from "./neuralVoice";
import { libraryVoiceFor } from "./voiceLibrary";

export type VoicePriority = "fuse" | "ask" | "ceremony" | "ambient";
export type VoiceGate = "ritual-only" | "all" | "captions";

export interface Utterance {
  role: string;
  persona: string;
  text: string;
  priority: VoicePriority;
  /** 音色覆盖（织伴等自定义音色场景；缺省走 role 预设） */
  voiceOverride?: VoiceProfile;
}

export interface VoiceProfile {
  pitch: number;
  rate: number;
  female?: boolean;
  /** 按顺序锁定系统音色；用于固定人物声线，禁止段落间换人。 */
  preferredNames?: string[];
  /** 是否使用本机克隆音色：true=强制、false=禁用、undefined=按角色默认（织伴用） */
  neural?: boolean;
  /** 克隆音色档案名（配音工位 profiles/<name>）；缺省用构建期 VITE_WORKLOOM_VOICE_PROFILE */
  neuralProfile?: string;
}

export interface Caption {
  id: number;
  persona: string;
  role: string;
  text: string;
  /** 预计展示毫秒（按 4.5 字/秒估算，下限 2.2s） */
  ttl: number;
  priority: VoicePriority;
}

export type VoicePlaybackResult = "spoken" | "skipped" | "cancelled";

interface QueuedUtterance {
  utterance: Utterance;
  resolve?: (result: VoicePlaybackResult) => void;
  settled?: boolean;
}

const DEFAULT_PRESET: VoiceProfile = { pitch: 1.0, rate: 0.96 };

/**
 * 角色 → 音色：走**音色库**（voiceLibrary.ts，单一事实源）。
 * 角色专属音色仍可由 Bundle 投影显式传入 voiceOverride 覆盖（如织伴的萝莉档）。
 */
export function voiceProfileForRole(role: string): VoiceProfile {
  if (!role.trim()) return DEFAULT_PRESET;
  return libraryVoiceFor(role).profile;
}

// macOS / Windows 常见中文系统音色。这里只用于性别与稳定性排序，不依赖某台机器
// 必须安装其中某一个；匹配不到时仍固定回落到同一个中文 voice。
const FEMALE_VOICE_RE = /female|flo|sandy|shelley|ting[- ]?ting|tingting|mei[- ]?jia|sin[- ]?ji|xiaoxiao|xiaoyi|yunxia|huihui|yaoyao|lily|xiaobei|晓晓|晓伊|婷婷|美佳|善怡/i;
const MALE_VOICE_RE = /male|eddy|reed|rocko|li[- ]?mu|yunxi|yunjian|yunyang|xiaoyu|云希|云健|云扬|晓宇|李沐/i;

/**
 * macOS「新奇音色」一族（Eddy/Reed/Flo/Sandy/Shelley/Rocko/Grandma/Grandpa）。
 *
 * 实测（2026-09-18，macOS + Electron 44 真实壳）：这组音色在 zh-CN 下**能出声但不发
 * `onboundary` 事件**（同一句中文：它们 0 次 boundary，而 婷婷 15 次 / Li-Mu 13 次）。
 * 基座的口型同步链路正是靠 boundary 的 charIndex 驱动（MateLive2D / VoiceEngine.onLipSync），
 * 于是"看起来在说话、嘴却不动"。因此把它们降级为最后兜底：只有在没有任何正常中文音色时才用。
 */
export const DEGRADED_VOICE_RE = /^(eddy|reed|flo|sandy|shelley|rocko|grandma|grandpa)\b/i;

/** 把中文音色按"可用性"重排：正常音色在前，新奇音色垫底（保持原有 zh-CN 优先次序，稳定排序）。 */
export function rankZhVoices<T extends { name: string }>(zh: readonly T[]): T[] {
  return [...zh].sort((a, b) => Number(DEGRADED_VOICE_RE.test(a.name)) - Number(DEGRADED_VOICE_RE.test(b.name)));
}

export interface VoiceLike { name: string; lang: string }

/**
 * 纯函数：从系统音色列表里为某个角色挑音色（无缓存、无副作用，可单测）。
 * 规则：中文优先（zh-CN 在前）→ 只要存在正常中文音色就不用新奇音色 → 首选名 → 性别 → 兜底第一个。
 */
export function selectVoice<T extends VoiceLike>(voices: readonly T[], profile: VoiceProfile): T | null {
  const zh = voices
    .filter((v) => /zh|cmn|chinese/i.test(`${v.lang} ${v.name}`))
    .sort((a, b) => Number(!/^zh[-_]cn/i.test(a.lang)) - Number(!/^zh[-_]cn/i.test(b.lang)) || a.name.localeCompare(b.name));
  if (zh.length === 0) return null;
  const ranked = rankZhVoices(zh);
  const usable = ranked.filter((v) => !DEGRADED_VOICE_RE.test(v.name));
  const base = usable.length > 0 ? usable : ranked;
  /**
   * 性别硬约束（2026-09-20 真机反馈「织伴一会儿男声一会儿女声」的根治）：
   * 声明 female 的角色绝不回落到男声——只要还有非男声候选就只用它们；
   * 声明 male 的角色对称处理。池子清空（极简装机只装了单一性别音色）才退回原池。
   */
  const pool = profile.female === true
    ? (base.some((v) => !MALE_VOICE_RE.test(v.name)) ? base.filter((v) => !MALE_VOICE_RE.test(v.name)) : base)
    : profile.female === false
      ? (base.some((v) => !FEMALE_VOICE_RE.test(v.name)) ? base.filter((v) => !FEMALE_VOICE_RE.test(v.name)) : base)
      : base;
  const preferred = profile.preferredNames
    ?.map((name) => pool.find((v) => v.name.toLowerCase().includes(name.toLowerCase())))
    .find(Boolean);
  const gendered = profile.female === true
    ? pool.find((v) => FEMALE_VOICE_RE.test(v.name))
    : profile.female === false
      ? pool.find((v) => MALE_VOICE_RE.test(v.name))
      : undefined;
  return preferred ?? gendered ?? pool[0] ?? null;
}

type CaptionListener = (c: Caption) => void;

export class VoiceEngineImpl {
  private queue: QueuedUtterance[] = [];
  private speaking = false;

  constructor() {
    // 每页探测一次本机工位能力：探到了走克隆音色，探不到走系统语音（探测不阻塞播报）
    void probeNeuralVoice();
  }
  private active: QueuedUtterance | null = null;
  private activeFinish: (() => void) | null = null;
  private generation = 0;
  private captionListeners = new Set<CaptionListener>();
  private captionSeq = 0;
  private exclusiveRole: string | null = null;
  private voiceCache = new Map<string, SpeechSynthesisVoice | null>();
  gate: VoiceGate = (typeof localStorage !== "undefined" && (localStorage.getItem("wl-voice-gate") as VoiceGate)) || "ritual-only";

  get tts(): SpeechSynthesis | null {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
    return window.speechSynthesis;
  }
  get available(): boolean {
    return this.tts !== null && this.gate !== "captions";
  }

  get voiceDiagnostics(): Record<string, string> {
    // 缓存键形如 `role|f`（性别档）；诊断只按角色名上报，保持既有口径可读
    return Object.fromEntries([...this.voiceCache].map(([key, voice]) => [key.split("|")[0] ?? key, voice ? `${voice.name} (${voice.lang})` : "system-default-locked"]));
  }

  setGate(gate: VoiceGate): void {
    this.gate = gate;
    try { localStorage.setItem("wl-voice-gate", gate); } catch { /* 静默 */ }
    if (gate === "captions") this.stopAll();
  }

  onCaption(fn: CaptionListener): () => void {
    this.captionListeners.add(fn);
    return () => this.captionListeners.delete(fn);
  }

  private emitCaption(u: Utterance): void {
    const ttl = Math.max(2200, Math.round((u.text.length / 4.5) * 1000));
    const cap: Caption = { id: ++this.captionSeq, persona: u.persona, role: u.role, text: u.text, ttl, priority: u.priority };
    for (const fn of this.captionListeners) { try { fn(cap); } catch { /* 静默 */ } }
  }

  private pickVoice(profile: VoiceProfile, role: string): SpeechSynthesisVoice | null {
    /**
     * 缓存键把角色与"性别档"绑在一起：同一角色不会因为先后拿到不同 profile
     * （例如设置面板切档、或某处漏传 voiceOverride）而在段落之间换人。
     */
    const cacheKey = `${role}|${profile.female === true ? "f" : profile.female === false ? "m" : "n"}`;
    if (this.voiceCache.has(cacheKey)) return this.voiceCache.get(cacheKey) ?? null;
    const voices = this.tts?.getVoices() ?? [];
    const zh = voices
      .filter((v) => /zh|cmn|chinese/i.test(`${v.lang} ${v.name}`))
      .sort((a, b) => Number(!/^zh[-_]cn/i.test(a.lang)) - Number(!/^zh[-_]cn/i.test(b.lang)) || a.name.localeCompare(b.name));
    // 首次 voice 列表未就绪时也缓存 null：同一人物整场都使用系统默认声，
    // 不允许第二段突然换成另一位说话人。织伴在 2.4s 入场后才开口，正常机器
    // 此时列表已经可用；极端情况下宁可全程同一默认声，也不段落间变声。
    if (zh.length === 0) { this.voiceCache.set(cacheKey, null); return null; }
    const chosen = selectVoice(voices, profile) as SpeechSynthesisVoice | null;
    if (chosen) this.voiceCache.set(cacheKey, chosen);
    return chosen;
  }

  /**
   * 系统音色表冷启动等待（2026-09-21 真机修复）。
   *
   * 真机反馈：开场第一句"我是织伴…"是**男声**，后面才变女声。
   * 根因：Chromium 的 `speechSynthesis.getVoices()` 首次调用常常返回空数组
   * （列表由 `voiceschanged` 异步送达）。旧实现遇到空列表就把 `null` 缓存下来，
   * 于是"性别硬约束"在最关键的第一句上失效——utterance 不带 voice，
   * 直接落到操作系统默认声（macOS 中文默认常为男声）。
   * 现在：性别有约束的角色**第一次开口前**先等音色表（有上限），
   * 表就绪后照旧锁定同一位音色整场不换人；等不到才退回系统默认声并锁定。
   */
  /**
   * 首次开口前等音色表的上限（一次性成本，每角色只等一次）。
   * 真机实测（2026-09-21，打包客户端）：页面刚加载时 `getVoices()` 返回 0，
   * 音色表要数秒后才由 Chromium 异步送达；等得不够久，第一句仍会落到系统默认男声。
   * 字幕在入队时就已经发出（见 enqueue → emitCaption），等待期间用户看得到文字，不会"卡住"。
   */
  static readonly VOICE_READY_TIMEOUT_MS = 5000;

  /** 等系统音色表就绪（事件优先 + 轮询兜底；到点即返回，不阻塞仪式）。 */
  waitForVoices(timeoutMs = VoiceEngineImpl.VOICE_READY_TIMEOUT_MS): Promise<void> {
    const tts = this.tts;
    if (!tts || tts.getVoices().length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const startedAt = Date.now();
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const tick = () => {
        if (tts.getVoices().length > 0 || Date.now() - startedAt >= timeoutMs) { done(); return; }
        setTimeout(tick, 80);
      };
      try {
        const onChanged = () => { if (tts.getVoices().length > 0) done(); };
        tts.addEventListener?.("voiceschanged", onChanged);
        setTimeout(() => { try { tts.removeEventListener?.("voiceschanged", onChanged); } catch { /* 静默 */ } }, timeoutMs + 500);
      } catch { /* 平台不支持事件时靠轮询 */ }
      setTimeout(tick, 80);
    });
  }

  /**
   * 首次定声前的等待：只在"性别有约束 + 该角色还没定过声 + 音色表为空"时等，
   * 保证不会出现"第一句默认男声、第二句换女声"这种同人换声。
   */
  private async ensureVoiceDecision(profile: VoiceProfile, role: string): Promise<void> {
    if (profile.female === undefined) return;
    const cacheKey = `${role}|${profile.female === true ? "f" : "m"}`;
    if (this.voiceCache.has(cacheKey)) return;
    if ((this.tts?.getVoices().length ?? 0) > 0) return;
    await this.waitForVoices();
  }

  /** 应用启动即预热音色表（首装开场前把列表准备好，避免第一句抢跑）。 */
  warmUp(): void {
    void this.waitForVoices(3000);
  }

  private settle(item: QueuedUtterance, result: VoicePlaybackResult): void {
    if (item.settled) return;
    item.settled = true;
    item.resolve?.(result);
  }

  private enqueue(u: Utterance, resolve?: QueuedUtterance["resolve"]): void {
    // 字幕永远发（字幕条是降级与可及性保底）
    this.emitCaption(u);
    const item: QueuedUtterance = { utterance: u, resolve };
    // 首装开场等独占叙事期间，后台晨报/环境事件只保留字幕，不能进入音频队列抢话。
    // fuse 仍保留安全语义，可明确中断任何播报。
    if (this.exclusiveRole && u.role !== this.exclusiveRole && u.priority !== "fuse") {
      this.settle(item, "skipped");
      return;
    }
    if (!this.available) { this.settle(item, "skipped"); return; }
    // 档位过滤：ritual-only 只放 fuse/ceremony
    if (this.gate === "ritual-only" && (u.priority === "ask" || u.priority === "ambient")) {
      this.settle(item, "skipped");
      return;
    }
    if (u.priority === "fuse") {
      this.stopAll();
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }
    void this.pump();
  }

  /** 播报（同时发字幕；语音按档位决定是否真出声） */
  speak(u: Utterance): void {
    this.enqueue(u);
  }

  /** 播报并等待真实结束；仪式编排用它避免按估算时长切段而抢话。 */
  speakAndWait(u: Utterance): Promise<VoicePlaybackResult> {
    return new Promise((resolve) => this.enqueue(u, resolve));
  }

  /** 获取独占播报会话；返回幂等释放函数。 */
  acquireExclusive(role: string): () => void {
    this.exclusiveRole = role;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.exclusiveRole === role) this.exclusiveRole = null;
    };
  }

  /* ---- 口型同步钩子（数字人驱动）：boundary/start/end 三事件 ---- */
  private lipListeners = new Set<(ev: { type: "start" | "boundary" | "end"; charIndex?: number; role?: string; text?: string }) => void>();
  onLipSync(cb: (ev: { type: "start" | "boundary" | "end"; charIndex?: number; role?: string; text?: string }) => void): () => void {
    this.lipListeners.add(cb);
    return () => this.lipListeners.delete(cb);
  }
  private emitLip(ev: { type: "start" | "boundary" | "end"; charIndex?: number; role?: string; text?: string }): void {
    for (const cb of this.lipListeners) { try { cb(ev); } catch { /* 静默 */ } }
  }

  stopAll(): void {
    this.generation += 1;
    const queued = this.queue.splice(0);
    for (const item of queued) this.settle(item, "cancelled");
    if (this.active) this.settle(this.active, "cancelled");
    this.active = null;
    this.speaking = false;
    const finish = this.activeFinish;
    this.activeFinish = null;
    try { this.tts?.cancel(); } catch { /* 静默 */ }
    AudioEngine.setSpeechActive(false);
    finish?.();
  }

  private async pump(): Promise<void> {
    if (this.speaking) return;
    const tts = this.tts;
    if (!tts) return;
    const item = this.queue.shift();
    if (!item) return;
    const next = item.utterance;
    const generation = this.generation;
    this.speaking = true;
    this.active = item;
    try {
      const preset = next.voiceOverride ?? voiceProfileForRole(next.role);
      // 小织/织伴：优先本机克隆音色（音色档案在工位本机，声纹不出域）；
      // 工位未配置/不可达/解码失败 → 返回 false，继续走下面的系统语音（宁可换声线，不让播报消失）。
      if (neuralVoiceAvailable() && wantsNeuralVoice(next.role, next.persona, { neural: preset.neural })) {
        const played = await this.speakNeural(next, preset);
        if (played) {
          this.settle(item, "spoken");
          this.active = null;
          this.speaking = false;
          if (this.queue.length > 0) void this.pump();
          return;
        }
      }
      // 性别有硬约束的角色（织伴/女声岗位）：首次开口前等音色表就绪，避免第一句用系统默认男声
      await this.ensureVoiceDecision(preset, next.role);
      const utt = new SpeechSynthesisUtterance(next.text);
      utt.lang = "zh-CN";
      utt.pitch = preset.pitch;
      utt.rate = preset.rate;
      const v = this.pickVoice(preset, next.role);
      if (v) utt.voice = v;
      // 真机可观测：把"这一句用了谁的声音"写进 DOM，供渲染冒烟与人工排障取证
      try {
        if (typeof document !== "undefined") {
          document.documentElement.dataset.wlVoice = `${next.role}:${v ? v.name : "system-default"}`;
          document.documentElement.dataset.wlVoices = String(tts.getVoices().length);
        }
      } catch { /* 静默 */ }
      await new Promise<void>((resolve) => {
        let done = false;
        let timeout = 0;
        const finish = () => {
          if (done) return;
          done = true;
          if (timeout) window.clearTimeout(timeout);
          if (this.activeFinish === finish) this.activeFinish = null;
          AudioEngine.setSpeechActive(false);
          resolve();
        };
        this.activeFinish = finish;
        utt.onstart = () => this.emitLip({ type: "start", role: next.role, text: next.text });
        utt.onboundary = (e: SpeechSynthesisEvent) => {
          this.emitLip({ type: "boundary", charIndex: e.charIndex ?? 0, role: next.role, text: next.text });
        };
        utt.onend = () => { this.emitLip({ type: "end", role: next.role }); finish(); };
        utt.onerror = () => { this.emitLip({ type: "end", role: next.role }); finish(); };
        // 超时兜底（部分平台 onend 不触发）
        timeout = window.setTimeout(() => { this.emitLip({ type: "end", role: next.role }); finish(); },
          Math.max(8000, next.text.length * 650));
        AudioEngine.setSpeechActive(true);
        tts.speak(utt);
      });
    } catch { /* 静默 */ }
    if (generation !== this.generation) return;
    this.settle(item, "spoken");
    this.active = null;
    this.speaking = false;
    if (this.queue.length > 0) void this.pump();
  }
  /** 播放本机克隆音色；口型由播放进度驱动（克隆音频没有 onboundary 事件）。 */
  private async speakNeural(u: Utterance, preset: VoiceProfile): Promise<boolean> {
    return await playNeuralSpeech(
      u.text,
      {
        onStart: () => {
          AudioEngine.setSpeechActive(true);
          this.emitLip({ type: "start", role: u.role, text: u.text });
        },
        onProgress: (ratio) => {
          this.emitLip({
            type: "boundary",
            charIndex: Math.max(0, Math.min(u.text.length, Math.floor(ratio * u.text.length))),
            role: u.role,
            text: u.text,
          });
        },
        onEnd: () => {
          AudioEngine.setSpeechActive(false);
          this.emitLip({ type: "end", role: u.role });
        },
      },
      preset.neuralProfile ? { config: { ...neuralVoiceConfig(), profile: preset.neuralProfile } } : {},
    );
  }
}

export const VoiceEngine = new VoiceEngineImpl();
