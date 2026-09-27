/**
 * gate-policy.ts —— 预生产门策略（内部准备门 / 花钱与对外门的判定口径）
 *
 * 为什么单独成文件（T-2026-0925-0002）：
 *   这套口径原先只写在 `studio-worker.ts` 里，只有"服务端跑 run"这一条路径能用。
 *   而逐环节审计要跑**不提交生产渲染的完整数据管线**（`scripts/tools/data-pipeline-run.mts`），
 *   如果审计脚本自己抄一份门口径，就会立刻出现"审计过的门 ≠ 生产的门"的漂移。
 *   抽成共享模块后，服务端与审计脚本消费同一份定义。
 *
 * 产品口径（2026-09-21 产品所有者）：内部门全自动（AI 监制评审），人审只留
 * ① 业务决策（说什么、长什么样）② 花钱或对外（渲染提交 G8 / 公网发布 G9 / 对外评论 G10）。
 */
import type { GateKey } from "@hyperreality/video-studio";
import type { ProducerStage } from "@hyperreality/video-studio";
import { mkdirSync, writeFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import type { ProducerArtifact, DeterministicCheck, PortraitIndex } from "@hyperreality/video-studio";

/**
 * 自动放行的「内部准备门」。默认包含 G1–G7；`HR_AUTO_GATES` 可覆盖
 * （逗号分隔；设为空字符串即恢复"全部门人审"的旧口径）。
 */
export const AUTO_GATES = new Set(
  (process.env.HR_AUTO_GATES
    ?? "G1_DOSSIER,G2_THEME,G3_INSIGHT,G4_PRD,G5_PORTRAIT,G6_PROMPT,G7_FINAL")
    .split(",").map((value) => value.trim()).filter(Boolean),
);

/** 内部门三档处置：review=AI 监制（默认）/ auto=无条件放行（应急）/ human=等人点 */
export type ProducerMode = "review" | "auto" | "human";

export function producerModeFromEnv(env: NodeJS.ProcessEnv = process.env): ProducerMode {
  const raw = (env.HR_PRODUCER ?? "review").trim().toLowerCase();
  return raw === "auto" || raw === "human" ? (raw as ProducerMode) : "review";
}

/** 门 → 监制评审环节（决定默认评审要点；`producer-gate` 里定义） */
export const GATE_PRODUCER_STAGE: Partial<Record<GateKey, ProducerStage>> = {
  G1_DOSSIER: "script",
  G2_THEME: "script",
  G3_INSIGHT: "script",
  G4_PRD: "prompt",
  G5_PORTRAIT: "keyframe",
  G6_PROMPT: "prompt",
  G7_FINAL: "prompt"
};

/** 逐门评审要点（在通用 rubric 之上叠加该门的专属口径） */
export const GATE_RUBRIC: Partial<Record<GateKey, string[]>> = {
  G1_DOSSIER: ["逐条核对facts中的原文引用和支持关系评审，档案/摘要卡不能新增未经claims支持的事实，用户输入不是事实来源",
    "A2/A3没有证据时必须保留明确用途限制；无证据不等于负面结论，不允许创造用户口碑、竞品对比或数字主张",
    "商品型号/价格时点/计量单位与来源一致，来源冲突必须拒绝；与项目主题相关，不含无关行业商品"],
  G2_THEME: ["主题/受众/时长/画幅与需求一致", "不出现与主题无关的红线意象（科幻/微观/无关地域）"],
  G3_INSIGHT: ["需求对齐清单覆盖角色/场景/道具/动作四类契约", "受众与风险项有具体结论，不是占位文字"],
  G4_PRD: ["角色系统有可执行的外观锚点（定妆照前置）", "交付标准可验证（画幅/时长/音频/字幕口径）"],
  G5_PORTRAIT: ["定妆照必须真出图（completedPortraits>0），不接受只有规格包的 pending 状态", "必需角度 front/threeQuarter/closeup/side 齐备", "人物与角色档案一致（授权真人须与本人照片同一张脸）"],
  G6_PROMPT: ["每镜提示词达到交付口径（≥1200 字）且 25/30 字段齐备", "台词速率与占比合规，无红线词"],
  G7_FINAL: ["预生产收口：镜头卡/定妆照/提示词三件套齐备且互相引用一致", "渲染提交前的花额度动作仍需人审（本门只放行内部准备）"]
};

/**
 * 门内容的确定性检查（零 token 先判）：
 * 空内容 / 占位符 / 声称完成但没有产物 —— 一律硬失败，不浪费模型额度。
 */
export function gateDeterministicChecks(gate: GateKey, content: string): Array<{ id: string; pass: boolean; detail: string; hard?: boolean }> {
  const text = content ?? "";
  const trimmed = text.trim();
  if (gate === "G1_DOSSIER") {
    let valid = false;
    try {
      const value = JSON.parse(trimmed) as { facts?: { schemaVersion?: string; stages?: unknown[]; sources?: unknown[] } };
      valid = value.facts?.schemaVersion === "workloom.marketing-facts/v1" && value.facts.stages?.length === 3
        && Array.isArray(value.facts.sources) && value.facts.sources.length > 0;
    } catch { valid = false; }
    return [{ id: "marketing-facts-present", pass: valid, hard: true,
      detail: valid ? "完整本次来源/三站事实包可解析；null等JSON值不会当作占位词误杀" : "G1必须读取宿主本次完整来源事实包" }];
  }
  const checks = [
    { id: "content-present", pass: trimmed.length > 0, hard: true, detail: trimmed.length > 0 ? `门内容 ${trimmed.length} 字` : "门内容为空（vendor 未产出该环节产物）" },
    { id: "no-placeholder", pass: !/undefined|null(?![\w])|NaN|\[object Object\]/.test(trimmed), hard: true, detail: /undefined|null(?![\w])|NaN|\[object Object\]/.test(trimmed) ? "门内容含 undefined/null/NaN/[object Object] 占位" : "无占位符泄漏" },
    { id: "min-length", pass: trimmed.length >= 120, hard: true, detail: `内容长度 ${trimmed.length}（下限 120，过短通常意味着上游字段过薄）` }
  ];
  if (gate === "G5_PORTRAIT") {
    const pendingOnly = /completedPortraits["'\s:]+0/.test(trimmed) || /"pending"\s*:\s*true/.test(trimmed);
    checks.push({ id: "portrait-produced", pass: !pendingOnly, hard: true, detail: pendingOnly ? "定妆照仍是 pending / completedPortraits=0（只有规格包，未真出图）" : "定妆照有实际出图记录" });
    const angles = ["front", "threeQuarter", "closeup", "side"];
    const missing = angles.filter((a) => !trimmed.includes(a) && !trimmed.includes(a.toLowerCase().replace("threequarter", "three_quarter")));
    checks.push({ id: "required-angles", pass: missing.length === 0, hard: missing.length >= 3, detail: missing.length === 0 ? "必需角度齐备" : `门内容未提到角度：${missing.join("/")}` });
  }
  return checks;
}

/**
 * 把门内容落盘成**真实文件**再送给 AI 监制（T-2026-0925-0002 真机根因）。
 *
 * 为什么必须有：`reviewStage` 的正文是从 `artifacts[].path` **读文件**的；
 * 此前服务端传的是 `${gate}:${vendorType}` 这种"标签路径"（不是文件），监制读不到 →
 * 只剩 rubric 里 600 字摘录 → 门内容后半段（需求契约、结论摘要、弧线收束…）等于不存在，
 * 于是反复出现"契约缺失/结论缺失"的误杀（真机 VID-AUDIT-M3/M4/M6 连续三轮）。
 *
 * 纪律：写盘只是把**同一份门内容**交给评审，不新增/不裁剪语义；文件名带 gate 与序号便于审计。
 */
export function writeGateArtifact(
  workDir: string,
  projectId: string,
  gate: string,
  contentMd: string,
): { path: string; chars: number } {
  const dir = join(workDir, "gates", projectId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${gate}.md`);
  writeFileSync(file, contentMd ?? "", "utf8");
  return { path: file, chars: (contentMd ?? "").length };
}

/**
 * 判断一次预生产结果是否属于「AI 监制打回（内部门不合格）」。
 *
 * 用途：门语义是"打回重跑"，而不是"打回停线"（`docs/pipeline-stages-and-gates-2026-09-24.md`
 * 里 CLI 侧就是逐环节重跑）。宿主据此做**有上限的自动重跑**，超限才停线并上报。
 */
export function isProducerRejection(result: {
  success?: boolean;
  confirmations?: Record<string, unknown>;
}): boolean {
  if (result?.success) return false;
  const confirmations = result?.confirmations ?? {};
  return Object.values(confirmations).some((value) => {
    const record = (value && typeof value === "object") ? value as Record<string, unknown> : null;
    if (!record || record.approved !== false) return false;
    const reason = String(record.reason ?? "");
    return reason.includes("producer-rejected") || reason.includes("producer_unavailable");
  });
}


/** G5 的事实由本次引擎结构结果与真实索引/图片共同给出；不从确认单里的自述推断出图。 */
export function portraitGateEvidence(input: {
  workDir: string; projectId: string; stage: unknown; scriptReport: unknown;
}): { artifacts: ProducerArtifact[]; deterministic: DeterministicCheck[]; notApplicable: boolean } {
  const stage = input.stage && typeof input.stage === "object" ? input.stage as Record<string, unknown> : {};
  const report = input.scriptReport && typeof input.scriptReport === "object" ? input.scriptReport as Record<string, unknown> : {};
  if (stage.status === "skipped" && stage.reason === "no-characters-or-products" && report.characters_count === 0) {
    return { artifacts: [], notApplicable: true, deterministic: [{ id: "portrait-applicability", status: "not_applicable", pass: false, hard: true,
      detail: "本次剧本结构 characters_count=0 且 PortraitStudio 无角色/商品任务" }] };
  }
  const fail = (detail: string) => ({ artifacts: [], notApplicable: false,
    deterministic: [{ id: "portrait-files", pass: false, hard: true, detail }] });
  try {
    if (stage.status !== "completed" || !(Number(stage.completedPortraits) > 0) || Number(stage.pendingPortraits) !== 0) return fail("本次定妆照未完整生成，不能用旧图片或计划书代替");
    const base = realpathSync(input.workDir);
    const root = resolve(base, "characters", input.projectId);
    if (!root.startsWith(`${base}${sep}`) || realpathSync(root) !== root) return fail("定妆照目录越界或经过符号链接");
    const indexPath = join(root, "portrait-index.json");
    if (realpathSync(indexPath) !== indexPath) return fail("定妆照索引经过符号链接");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as PortraitIndex;
    if (index.schemaVersion !== "workloom.portrait-index/v1" || index.projectId !== input.projectId) return fail("定妆照索引不属于当前项目");
    const characters = Object.values(index.characters ?? {}), products = Object.values(index.products ?? {});
    if (characters.length !== Number(stage.characters) || products.length !== Number(stage.products)) return fail("实际定妆照主体数与本次生成任务不一致");
    const artifacts: ProducerArtifact[] = [{ path: indexPath, kind: "json", note: "本次实际角色/商品及角度索引" }];
    for (const item of [...characters, ...products]) {
      const entries = Object.entries(item.files ?? {});
      if (item.kind === "character" && ["front", "threeQuarter", "closeup", "side"].some(angle => !item.files?.[angle])) return fail(`角色 ${item.id} 缺少必需的四角度`);
      if (entries.length === 0) return fail("主体没有实际出图文件");
      for (const [angle, file] of entries) {
        const absolute = resolve(base, relative(resolve(input.workDir), resolve(file)));
        if (!absolute.startsWith(`${root}${sep}`) || realpathSync(file) !== absolute || !statSync(absolute).isFile() || statSync(absolute).size === 0) return fail("定妆照文件缺失、为空、越界或经过符号链接");
        artifacts.push({ path: absolute, kind: "image", note: `${item.kind}:${item.id}:${angle}` });
      }
    }
    if (artifacts.length === 1) return fail("定妆照索引没有可送审图片");
    return { artifacts, notApplicable: false, deterministic: [
      { id: "portrait-files", pass: true, hard: true, detail: `${artifacts.length - 1} 张当前项目图片已读取并与本次任务数量核对` },
      { id: "required-angles", pass: true, hard: true, detail: "所有人物四角度完整，商品有实际视图" },
    ] };
  } catch (error) { return fail(`实际定妆照证据不可读取：${error instanceof Error ? error.message : String(error)}`); }
}
