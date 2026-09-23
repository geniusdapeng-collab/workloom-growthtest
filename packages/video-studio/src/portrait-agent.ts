/**
 * portrait-agent —— 定妆照生成 Agent（2026-09-24）
 *
 * 定位：**专做一件事**——为一个角色档案生成"纯写实 + 场景解耦"的定妆照集（默认 4 角度），
 * 产出直接写回档案库（`portraits/vN` + `portrait-sets/vN.json` + `profile.json#portraitSets`）。
 * 后续要升级只改本 Agent（模板/参数/校验），不再散落在各处提示词里。
 *
 * 纪律（来自设计文档附录 A.1/A.2 的实测结论）：
 *   ① 只描述人（外貌/发型/服装）+ 中性浅灰背景 + 中性柔光 5600K；**不写地点/道具/时段**；
 *   ② 禁止美颜与 CG 词（超写实/CG/3D 渲染/8K 渲染/柔光箱），否则出图带塑料感；
 *   ③ 白平衡锚点前置，显式排除 golden hour / 暖黄滤镜；
 *   ④ 出片侧的对应纪律见 `shot-spec.ts#SCENE_DECOUPLE_CLAUSE`（场景只由镜头提示词给）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { REQUIRED_PORTRAIT_ANGLES, type CharacterProfile, type PortraitSet } from "./character-archive.js";
import { REALISM_NEGATIVE_TERMS, STYLIZED_STYLES } from "./shot-spec.js";

export interface PortraitAgentConfig {
  /** 目标角度（默认渲染核心必需 4 角度） */
  angles?: string[];
  model?: string;
  seed?: number;
  size?: string;
  /** 版本号（默认自动 +1） */
  version?: number;
  /** 生成后是否置为 active（默认 true） */
  activate?: boolean;
  /** 图片接口基础地址 */
  baseUrl?: string;
}

/** 角度 → 构图指令（与 vendor angle-catalog 语义一致） */
const ANGLE_FRAMING: Record<string, string> = {
  front: "正面全身像，直立平视镜头，完整身形入画，脚尖完整",
  threeQuarter: "45 度侧身半身像，腰部以上入画，面部转向镜头",
  closeup: "面部特写（头肩以上），直视镜头，五官与皮肤细节清晰",
  side: "90 度正侧面全身像，侧轮廓清晰完整",
  back: "正背面全身像，背对镜头直立，背部与服装细节完整",
  actionPose: "标志性动作全身像，动态张力与身体结构清晰",
  emotionCloseup: "情绪特写，核心情绪状态，微表情层次清晰",
  handDetail: "手部特写，自然姿态与持物姿态清晰",
};

/** 写实（默认）模板：注意不含任何地点/道具/时段词，也不含 CG/超写实/影棚词 */
const PHOTOREAL_TEMPLATE = [
  "白平衡中性（日光 5600K，肤色自然），人像定妆照（与任何场景无关）：",
  "{appearance}",
  "背景为中性浅灰无缝背景，没有任何地点、建筑、道具、环境元素；",
  "光照为均匀的中性柔光（非影棚强光、无金色或橙色偏移）；",
  "皮肤保留真实毛孔与细颗粒，眼睛有自然眼神光；85mm 定焦，f/4，低饱和，不做美颜修饰",
].join("");

const PHOTOREAL_NEGATIVE = [
  "no scene", "no location", "no props", "no golden hour", "no warm filter", "no studio glamour",
  REALISM_NEGATIVE_TERMS,
].join(", ");

export interface PortraitPlan {
  characterId: string;
  name: string;
  version: number;
  angles: string[];
  /** 角度 → 正向提示词 */
  prompts: Record<string, string>;
  negativeTerms: string;
  mode: "photoreal" | "stylized";
  reason: string;
}

/** 角色档案 → 外观描述（写实模板的唯一角色变量） */
function appearanceOf(profile: CharacterProfile): string {
  const a = (profile.appearance ?? {}) as Record<string, unknown>;
  const i = (profile.identity ?? {}) as Record<string, unknown>;
  const wardrobe = Array.isArray(profile.wardrobe) && profile.wardrobe.length > 0
    ? (profile.wardrobe[0] as Record<string, unknown>)
    : {};
  /** 性别用中文（档案里可能是 female/male） */
  const genderMap: Record<string, string> = { female: "女性", male: "男性", woman: "女性", man: "男性" };
  const rawGender = String(a.gender ?? i.gender ?? "").trim().toLowerCase();
  const gender = genderMap[rawGender] ?? (rawGender || "人物");
  const age = i.age ? String(i.age) : "";
  const parts = [
    `一位${age ? `${age}` : ""}${gender}`,
    a.face ? String(a.face) : "",
    a.skin ? `肤质：${String(a.skin)}` : "",
    a.eyes ? `眼睛：${String(a.eyes)}` : "",
    a.hair ? `${String(a.hair)}发型` : "",
    wardrobe.name ? `穿着${String(wardrobe.name)}${wardrobe.detail ? `（${String(wardrobe.detail)}）` : ""}` : ""
  ].filter(Boolean);
  return `${parts.join("，")}。`;
}

/**
 * 规划一次定妆照生成（纯函数，可 dry-run）：默认写实；显式声明风格或非人主体才豁免。
 */
export function buildPortraitPlan(
  profile: CharacterProfile,
  config: PortraitAgentConfig = {}
): PortraitPlan {
  const angles = config.angles ?? [...REQUIRED_PORTRAIT_ANGLES];
  const existing = (profile.portraitSets ?? []).map((s) => s.version);
  const version = config.version ?? (existing.length > 0 ? Math.max(...existing) + 1 : 1);
  const declaredStyle = String((profile as unknown as Record<string, unknown>).style ?? "").trim().toLowerCase();
  const nonHuman = ["animal", "creature", "object", "product"].includes(String(profile.kind));
  const stylized = (STYLIZED_STYLES as readonly string[]).includes(declaredStyle) || nonHuman;
  const mode: PortraitPlan["mode"] = stylized ? "stylized" : "photoreal";
  const reason = nonHuman
    ? `角色类型为 ${profile.kind}（非人），不适用真人写实模板`
    : stylized
      ? `角色档案显式声明风格「${declaredStyle}」`
      : "默认口径（纯写实 + 场景解耦）";
  const appearance = appearanceOf(profile);
  const prompts: Record<string, string> = {};
  for (const angle of angles) {
    const framing = ANGLE_FRAMING[angle] ?? `${angle} 视角`;
    prompts[angle] = mode === "photoreal"
      ? `${PHOTOREAL_TEMPLATE.replace("{appearance}", appearance)}。${framing}。`
      : `${appearance}。${framing}。${declaredStyle ? `风格：${declaredStyle}。` : ""}`;
  }
  return {
    characterId: profile.id,
    name: profile.name,
    version,
    angles,
    prompts,
    negativeTerms: mode === "photoreal" ? PHOTOREAL_NEGATIVE : "",
    mode,
    reason
  };
}

export interface PortraitAgentResult {
  characterId: string;
  version: number;
  files: Record<string, string>;
  portraitSet: PortraitSet;
  profileFile: string;
  log: string[];
}

/**
 * 执行生成：逐角度调用 Seedream（文生图）→ 写入 `portraits/vN` → 追加 `portrait-sets/vN.json`
 * → 更新 `profile.json`（新集置 active，旧集取消 active）。失败即抛错（不写半套）。
 */
export async function runPortraitAgent(options: {
  libraryRoot: string;
  characterId: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  fetchImpl?: typeof fetch;
  config?: PortraitAgentConfig;
  log?: (line: string) => void;
}): Promise<PortraitAgentResult> {
  const log = options.log ?? (() => undefined);
  const logs: string[] = [];
  const say = (line: string): void => { logs.push(line); log(line); };
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
  const dir = join(options.libraryRoot, options.characterId);
  const profileFile = join(dir, "profile.json");
  if (!existsSync(profileFile)) throw new Error(`角色档案不存在：${profileFile}`);
  const profile = JSON.parse(readFileSync(profileFile, "utf8")) as CharacterProfile;
  const plan = buildPortraitPlan(profile, { ...options.config, model: options.model });
  say(`[portrait-agent] ${profile.name} v${plan.version}：${plan.mode}（${plan.reason}），角度 ${plan.angles.join("/")}`);

  const setDir = join(dir, "portraits", `v${plan.version}`);
  mkdirSync(setDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const angle of plan.angles) {
    const body: Record<string, unknown> = {
      model: options.model,
      prompt: plan.prompts[angle],
      response_format: "url",
      watermark: false,
      ...(options.config?.size ? { size: options.config.size } : {}),
      ...(options.config?.seed ? { seed: options.config.seed } : {})
    };
    const res = await fetchImpl(`${base}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`定妆照出图失败（${angle}）：HTTP ${res.status} ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text) as { data?: Array<{ url?: string }> };
    const url = parsed.data?.[0]?.url;
    if (!url) throw new Error(`定妆照出图失败（${angle}）：响应缺少 url`);
    const bytes = Buffer.from(await (await fetchImpl(url)).arrayBuffer());
    const file = join(setDir, `${profile.name}-${angle}.png`);
    writeFileSync(file, bytes);
    files[angle] = file;
    say(`  · ${angle} → ${file}（${bytes.byteLength} B）`);
  }

  const portraitSet: PortraitSet = {
    version: plan.version,
    dir: `portraits/v${plan.version}`,
    angles: plan.angles,
    source: "pure-t2i",
    active: options.config?.activate !== false,
    model: options.model,
    ...(options.config?.seed ? { seed: options.config.seed } : {}),
    prompt: plan.prompts[plan.angles[0] ?? "front"],
    createdAt: new Date().toISOString()
  };
  mkdirSync(join(dir, "portrait-sets"), { recursive: true });
  writeFileSync(join(dir, "portrait-sets", `v${plan.version}.json`), `${JSON.stringify(portraitSet, null, 2)}\n`);

  const sets = [...(profile.portraitSets ?? [])];
  if (portraitSet.active) for (const set of sets) set.active = false;
  sets.push(portraitSet);
  const updated: CharacterProfile = {
    ...profile,
    portraitSets: sets,
    portraitAgent: {
      model: options.model,
      angles: plan.angles,
      mode: plan.mode,
      negativeTerms: plan.negativeTerms,
      updatedAt: new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  } as CharacterProfile;
  writeFileSync(profileFile, `${JSON.stringify(updated, null, 2)}\n`);
  say(`[portrait-agent] 完成：v${plan.version}${portraitSet.active ? "（已置为 active）" : ""}；档案已更新`);
  return { characterId: profile.id, version: plan.version, files, portraitSet, profileFile, log: logs };
}
