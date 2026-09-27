/**
 * 角色一致性判据（2026-09-26 真机事故沉淀 · 产品所有者点名"角色一致性判据"）
 *
 * 事故形态：生成模型在**不相关的镜头**里插入了"主角形象"——本片 NC-10（夜市瓦罐汤）开头 7 帧里
 * 出现一个"白衣女主"（与前面镜头的深色工作服完全不同），听感/观感就是**角色串戏**；
 * 上一轮误判成"有白衣就要整镜剔除"，把好镜头一起删了。
 *
 * 能力边界（如实写清，避免把它当人脸识别）：
 *   本判据**不做人脸识别**，只做"同一角色在不同镜头里的**造型主色一致性** + 未声明出镜"两项可机检的检查：
 *     · 取样口径统一：镜头中段帧的**中心区**（人物在竖版构图中通常居中）中位色；
 *     · 与角色锚（定妆照/该角色的首镜基准）比色差；
 *     · 明显不同色系 → 判失败（可用 `--accept-rejected character-consistency` 显式留痕放行）；
 *     · 中等差异 → 告警（提示人工/监制看一眼，不拦）。
 *
 * 它能抓住的：白衣 vs 深蓝工装这类"色系反转"的串戏；跨镜换装未声明。
 * 它抓不住的：同色系换装、面部差异、背影替身——那需要人脸/姿态模型（另开能力卡）。
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface CharacterConsistencyPolicy {
  /** 中等差异告警阈值（RGB 欧氏距离，满量程 √(255²×3)≈441） */
  warnDelta: number;
  /** 明显不同色系 → 判失败 */
  failDelta: number;
  /** 人物区域占比低于此值视为"该镜主体不是人物"，不参与造型比对 */
  minPresenceRatio: number;
}

export const CHARACTER_CONSISTENCY_POLICY: CharacterConsistencyPolicy = {
  warnDelta: 45,
  failDelta: 90,
  minPresenceRatio: 0.02,
};

export interface CharacterShotSample {
  shotId: string;
  /** 该镜声明的角色 id（缺省 = 未声明任何角色） */
  characterId?: string | null;
  /** 该镜声明的服装描述（原样保留，进证据） */
  declaredWardrobe?: string | null;
  /** 中心区中位色（取样口径见模块注释） */
  sampleColor: RgbColor | null;
  /** 人物区域占比（0–1；缺省视为未知，不参与"未声明出镜"判定） */
  presenceRatio?: number | null;
}

export interface CharacterAnchor {
  characterId: string;
  /** 角色锚色（定妆照/首镜基准的中心区中位色） */
  sampleColor: RgbColor;
  /** 锚来自哪一镜（证据） */
  fromShotId?: string;
}

export interface CharacterConsistencyIssue {
  kind: "wardrobe-drift" | "undeclared-person" | "cross-shot-drift";
  shotId: string;
  characterId?: string | null;
  delta?: number;
  detail: string;
}

export interface CharacterConsistencyReport {
  ok: boolean;
  issues: CharacterConsistencyIssue[];
  warnings: CharacterConsistencyIssue[];
  checked: number;
  skipped: string[];
  anchors: CharacterAnchor[];
  detail: string;
}

export function colorDelta(a: RgbColor, b: RgbColor): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/** 取中位色（对离群像素更稳；输入为空返回 null）。 */
export function medianColor(colors: RgbColor[]): RgbColor | null {
  if (colors.length === 0) return null;
  const pick = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  return {
    r: Math.round(pick(colors.map((c) => c.r))),
    g: Math.round(pick(colors.map((c) => c.g))),
    b: Math.round(pick(colors.map((c) => c.b))),
  };
}

/**
 * 判据主函数：
 *   ① 未声明出镜：`presenceRatio ≥ minPresenceRatio` 但 `characterId` 为空 → 告警（需人工确认是否串戏）；
 *   ② 造型漂移：声明了角色、但该镜中心区主色与该角色锚色差 ≥ failDelta → 失败；≥ warnDelta → 告警；
 *   ③ 跨镜漂移：同一角色在两镜之间主色差 ≥ failDelta → 失败（即使两镜都偏离锚色不多）。
 */
export function assessCharacterConsistency(input: {
  shots: readonly CharacterShotSample[];
  anchors: readonly CharacterAnchor[];
  policy?: CharacterConsistencyPolicy;
}): CharacterConsistencyReport {
  const policy = input.policy ?? CHARACTER_CONSISTENCY_POLICY;
  const anchorByCharacter = new Map(input.anchors.map((anchor) => [anchor.characterId, anchor]));
  const issues: CharacterConsistencyIssue[] = [];
  const warnings: CharacterConsistencyIssue[] = [];
  const skipped: string[] = [];
  const byCharacter = new Map<string, Array<{ shotId: string; color: RgbColor }>>();
  let checked = 0;

  for (const shot of input.shots) {
    const characterId = shot.characterId ?? null;
    if (!characterId) {
      if (typeof shot.presenceRatio === "number" && shot.presenceRatio >= policy.minPresenceRatio) {
        warnings.push({
          kind: "undeclared-person",
          shotId: shot.shotId,
          characterId: null,
          detail: `未声明角色但检出人物区域（占比 ${(shot.presenceRatio * 100).toFixed(1)}%）：`
            + "确认是否串戏/路人抢镜（本判据不做人脸识别，需人工看一眼）",
        });
      }
      continue;
    }
    if (!shot.sampleColor) {
      skipped.push(shot.shotId);
      continue;
    }
    checked += 1;
    const list = byCharacter.get(characterId) ?? [];
    list.push({ shotId: shot.shotId, color: shot.sampleColor });
    byCharacter.set(characterId, list);
    const anchor = anchorByCharacter.get(characterId);
    if (!anchor) {
      warnings.push({
        kind: "wardrobe-drift",
        shotId: shot.shotId,
        characterId,
        detail: `角色 ${characterId} 没有锚色（定妆照/首镜基准缺失），本镜只登记不比对`,
      });
      continue;
    }
    const delta = colorDelta(shot.sampleColor, anchor.sampleColor);
    if (delta >= policy.failDelta) {
      issues.push({
        kind: "wardrobe-drift",
        shotId: shot.shotId,
        characterId,
        delta: Number(delta.toFixed(1)),
        detail: `角色 ${characterId} 造型主色与锚（${anchor.fromShotId ?? "锚"}）差 ${delta.toFixed(1)}`
          + `（阈值 ${policy.failDelta}）——疑似换装未声明或角色串戏；声明服装：${shot.declaredWardrobe ?? "未写"}`,
      });
    } else if (delta >= policy.warnDelta) {
      warnings.push({
        kind: "wardrobe-drift",
        shotId: shot.shotId,
        characterId,
        delta: Number(delta.toFixed(1)),
        detail: `角色 ${characterId} 造型主色与锚差 ${delta.toFixed(1)}（告警阈值 ${policy.warnDelta}）：请人工确认是否换装未声明`,
      });
    }
  }

  for (const [characterId, list] of byCharacter) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const delta = colorDelta(list[i]!.color, list[j]!.color);
        if (delta >= policy.failDelta) {
          issues.push({
            kind: "cross-shot-drift",
            shotId: `${list[i]!.shotId}↔${list[j]!.shotId}`,
            characterId,
            delta: Number(delta.toFixed(1)),
            detail: `同一角色 ${characterId} 在 ${list[i]!.shotId} 与 ${list[j]!.shotId} 的造型主色差 ${delta.toFixed(1)}`
              + `（阈值 ${policy.failDelta}）——典型串戏形态（真机：白衣 vs 深蓝工装）`,
          });
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    checked,
    skipped,
    anchors: [...input.anchors],
    detail: issues.length === 0
      ? `角色一致性：比对 ${checked} 镜（锚 ${input.anchors.length} 个），无跨镜造型漂移；告警 ${warnings.length} 条`
      : `角色一致性失败 ${issues.length} 条：${issues.map((issue) => issue.detail).join("；")}`,
  };
}
