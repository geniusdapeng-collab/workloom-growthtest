/**
 * studio.ts —— 视频工作室核心桥：HyperrealitySystem（vendor）→ 视频经理运行时
 *
 * 职责：
 *  1. 装配 vendor 的 HyperrealitySystem（注入 WorkloomLLMEngine，禁止静默降级）
 *  2. 把 7 个确认门挂到宿主审批回调（宿主负责创建 IM 审批卡并等待裁决）
 *  3. 把流水线生命周期事件吐给宿主事件汇（宿主负责落 biz_events 五元事件）
 *  4. 产物（PRD/镜头提示词包/定妆照清单）以结构化结果返回，宿主入 asset-cms
 *
 * 本包不直接依赖 @workloom/* ——通过回调接口解耦，由 apps/server 完成接线。
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installConfirmationHandler, type ConfirmationHandler } from "./confirmation.js";
import { resolveGate, type GateVerdict } from "./gates.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import { createPortraitRuntime, type PortraitRuntimeOptions } from "./portrait-runtime.js";
import {
  installVendorConfigIsolatorBridge,
  installVendorContractBridge,
  installVendorFieldQualityBridge,
  installVendorMicroMotionBridge,
  installVendorDiscoveryFixBridge,
  installVendorPhaseInternalsDiagnostics,
  installVendorPhaseDiagnosticsBridge,
  installVendorPromptRebuildBridge
} from "./vendor-compat.js";

/** vendor 引擎暴露的最小结构（HyperrealitySystem 实例方法） */
interface HyperrealitySystemLike {
  create(
    intent: string,
    metadata: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<PreproductionResult>;
}

interface HyperrealitySystemCtor {
  new (options: Record<string, unknown>): HyperrealitySystemLike;
}

export interface PreproductionResult {
  success: boolean;
  stages?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 宿主审批回调：收到待审批内容，返回裁决（由 IM 审批卡驱动） */
export type ApprovalCallback = (approval: {
  gate: string;
  vendorType: string;
  title: string;
  contentMd: string;
  runId: string | null;
}) => Promise<GateVerdict>;

/** 宿主事件汇：流水线生命周期事件（宿主落五元事件库） */
export type EventSink = (event: {
  kind:
    | "pipeline.started"
    | "pipeline.gate.requested"
    | "pipeline.gate.resolved"
    | "pipeline.finished"
    | "pipeline.failed";
  projectId: string;
  runId: string | null;
  gate?: string;
  payload?: Record<string, unknown>;
}) => void | Promise<void>;

/** 定妆照真实出图配置（StudioConfig.portraits 口径；workDir/projectId 由 studio 运行期补齐） */
export type StudioPortraitConfig =
  | (Omit<PortraitRuntimeOptions, "workDir" | "projectId" | "log"> & { enabled?: true })
  | { enabled: false };

export interface StudioConfig {
  llm: WorkloomLLMEngine;
  /** 项目工作目录（checkpoints / characters / confirmations 等运行产物根） */
  workDir: string;
  onApproval: ApprovalCallback;
  onEvent?: EventSink;
  /** 总截止（毫秒），默认 1 小时，与 vendor 默认一致 */
  totalDeadlineMs?: number;
  llmTimeoutMs?: number;
  /**
   * 定妆照真实出图（火山方舟 Seedream）。缺省或 `enabled:false` 时保持 vendor 默认：
   * interactive + spec（只出规格包，不出图）——那是"等人确认"的旧口径，全自动预生产必须开启。
   */
  portraits?: StudioPortraitConfig;
  /**
   * 渲染移交宿主 render-operator（融合设计 §6：vendor 只做预生产，渲染由 render-operator
   * 按 G8 围栏提交）。true 时 vendor Layer 3 只做校验不提交 —— 避免同一批镜头被
   * vendor 与宿主各提交一次、双份烧额度。
   */
  deferRender?: boolean;
  /** 运行期日志（默认 console.log） */
  log?: (line: string) => void;
}

export interface RunInput {
  projectId: string;
  /** 创作意图原文（故事/主题/营销 Brief） */
  intent: string;
  metadata?: Record<string, unknown>;
  /** 是否为社媒营销类输入（决定是否强制情报层节点 0） */
  isMarketing?: boolean;
}

function resolveVendorEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/ 运行（tsx）与 dist/ 运行（构建产物）两种布局都尝试
  const candidates = [
    path.resolve(here, "../../../vendor/supermickey/hyperreality-system/index.js"),
    path.resolve(here, "../../../../vendor/supermickey/hyperreality-system/index.js")
  ];
  const require = createRequire(import.meta.url);
  for (const p of candidates) {
    try {
      require.resolve(p);
      return p;
    } catch {
      /* try next */
    }
  }
  throw new Error("未找到 vendor/supermickey/hyperreality-system/index.js");
}

export class VideoStudio {
  private readonly cfg: StudioConfig;

  constructor(cfg: StudioConfig) {
    this.cfg = cfg;
  }

  /**
   * 跑一条完整预生产流水线（节点 0 情报 → 主题 → 洞察 → PRD → 镜头提示词 → 定妆照）
   * 渲染不在此内：渲染由 render-operator 消费 render_scripts 后单独执行（融合设计 §6）
   */
  async runPreproduction(input: RunInput): Promise<PreproductionResult> {
    const { cfg } = this;
    const log = cfg.log ?? ((line: string) => console.log(line));
    const require = createRequire(import.meta.url);
    const { HyperrealitySystem } = require(resolveVendorEntry()) as {
      HyperrealitySystem: HyperrealitySystemCtor;
    };

    const emit: EventSink = (e) => (cfg.onEvent ? cfg.onEvent(e) : undefined);
    let runId: string | null = null;

    const handler: ConfirmationHandler = async (req) => {
      const gate = resolveGate(req.type);
      await emit({
        kind: "pipeline.gate.requested",
        projectId: input.projectId,
        runId: req.runId ?? runId,
        gate,
        payload: { vendorType: req.type }
      });
      const verdict = await cfg.onApproval({
        gate,
        vendorType: req.type,
        title: `预生产确认门 · ${gate}`,
        contentMd: req.content,
        runId: req.runId ?? runId
      });
      await emit({
        kind: "pipeline.gate.resolved",
        projectId: input.projectId,
        runId: req.runId ?? runId,
        gate,
        payload: { approved: verdict.approved, reason: verdict.reason }
      });
      return verdict;
    };

    const uninstall = installConfirmationHandler(handler);
    /**
     * 注入依赖保活（vendor ConfigIsolator 会摊平类实例，见 vendor-compat.ts）：
     * 必须在本实例装配之前打上，否则注入的 LLM 引擎在隔离后变成"空心对象"，
     * 链路最开头的创意主题生成器会静默降级成规则兜底（真机 2026-09-22 事故）。
     */
    const uninstallIsolator = installVendorConfigIsolatorBridge();
    /** 阶段异常栈诊断：Phase 3/3.5 失败时把栈写进 run 日志（vendor 只打 message，真机无法定位行号） */
    const uninstallPhaseDiagnostics = installVendorPhaseDiagnosticsBridge({ log });
    /**
     * 字段质检桥：Phase 3.5 对结构化 timeline 崩 `tl.match` / `result.reports` 缺失导致整套质检失败
     * （真机：FieldGuard 默认模板覆盖 6 镜并标记降级）。入参归一 + 结果兜底。
     */
    const uninstallFieldQuality = installVendorFieldQualityBridge({ log });
    /**
     * 微动作桥：`_extractCameraDistance` 只读 `camera`（实际字段是 camera_movement）+ 模板缺 neutral
     * → 真机两次 run 均 0/6 增强（环节空转）。补齐字段映射与 neutral 模板。
     */
    const uninstallMicroMotion = installVendorMicroMotionBridge({ log });
    /**
     * 契约桥：Phase1→2/2→3/3→Output 的类型不匹配此前只告警（且 autoFix 对逐镜头字段不生效），
     * 导致对象字段以 `[object Object]` 进入提示词。这里做入参归一 + 契约账本留痕。
     */
    const uninstallContract = installVendorContractBridge({ log });
    /**
     * 提示词重建桥：Phase 3 失败（真机 `Assignment to constant variable.`）时 6 镜 prompt 为空，
     * 最终被 PipelineGuard 严格模式拦下、整条 run 无产物。用 vendor 自己的组装器按字段重建，
     * 并标记 promptRebuilt（非静默兜底）。
     */
    const uninstallPromptRebuild = installVendorPromptRebuildBridge({ log });
    /** 需求洞察 _fillDefaults 修复（数组保形 + 消除 const 重赋值，静态审计发现） */
    const uninstallDiscoveryFix = installVendorDiscoveryFixBridge({ log });
    /** Phase 3 后融合链路深栈诊断（vendor 内部 catch 会吞掉栈帧） */
    const uninstallInnerDiagnostics = installVendorPhaseInternalsDiagnostics({ log });

    // 与 vendor CLI（app/commands/preproduction.js）保持同一装配口径
    process.env.STORMAXE_TOTAL_DEADLINE_MS =
      process.env.STORMAXE_TOTAL_DEADLINE_MS ?? String(cfg.totalDeadlineMs ?? 3_600_000);

    /**
     * 项目产物目录：checkpoints / characters / 渲染输出一律收在同一 workDir 下。
     * vendor 的三个引擎各自读 `options.<engine>.charactersDir`（顶层 charactersDir 不生效），
     * 必须逐个显式下发，否则引擎回落到 vendor 仓库自带的 characters/，定妆照与绑定清单会对不上。
     */
    const charactersDir = path.join(cfg.workDir, "characters", input.projectId);
    const renderOutputDir = path.join(cfg.workDir, "video-output", input.projectId);

    /**
     * 定妆照真实出图（2026-09-21 真机修复）：不开则 vendor 停在 interactive+spec →
     * completedPortraits=0 → 渲染门 BINDING_MANIFEST_INVALID。
     */
    const portraitCfg = cfg.portraits;
    const portraitRuntime = portraitCfg && portraitCfg.enabled !== false && portraitCfg.apiKey
      ? createPortraitRuntime({
          ...portraitCfg,
          workDir: cfg.workDir,
          projectId: input.projectId,
          log
        })
      : null;
    if (portraitCfg && portraitCfg.enabled !== false && !portraitCfg.apiKey) {
      log("[studio] 定妆照真实出图未启用：缺少图像模型密钥（保持 vendor 规格包口径，不出图）");
    }

    const system = new HyperrealitySystem({
      llmEngine: cfg.llm,
      productionEngine: {
        charactersDir,
        agentConfig: {
          enableLLMAgents: true,
          llmTimeout: cfg.llmTimeoutMs ?? 180_000,
          llmMaxRetries: 2,
          llmModel: cfg.llm.model,
          fastModel: cfg.llm.fastModel,
          totalDeadlineMs: cfg.totalDeadlineMs ?? 3_600_000,
          promptFusionConcurrency: 1,
          checkpointDir: path.join(cfg.workDir, "checkpoints", input.projectId),
          enableResume: true
        }
      },
      scriptEngine: { charactersDir },
      renderingEngine: { charactersDir, outputDir: renderOutputDir },
      charactersDir
    });

    await emit({ kind: "pipeline.started", projectId: input.projectId, runId: null });
    try {
      /**
       * vendor create 的第三参是"运行期开关"（batchMode/portraitExecutor/portraitRuntime/dryRun/skipRender）。
       * deferRender=true 时 Layer 3 不提交（渲染由宿主 render-operator 走 G8 围栏提交），
       * 避免 vendor 与宿主对同一批镜头各提交一次、双份烧额度。
       */
      const createOptions: Record<string, unknown> = {};
      if (cfg.deferRender === true) createOptions.skipRender = true;
      if (portraitRuntime) {
        createOptions.batchMode = true;
        createOptions.portraitExecutor = "api";
        createOptions.portraitRuntime = portraitRuntime;
        const modelName = portraitCfg && portraitCfg.enabled !== false ? portraitCfg.model : "未指定模型";
        log(`[studio] 定妆照真实出图已启用（${modelName}，产物根 ${charactersDir}）`);
      }
      const result = await system.create(input.intent, input.metadata ?? {}, createOptions);
      if (portraitRuntime) {
        const index = portraitRuntime.snapshot();
        const characters = Object.keys(index.characters).length;
        const products = Object.keys(index.products).length;
        log(`[studio] 定妆照索引落盘：${portraitRuntime.indexPath()}（角色 ${characters} / 商品 ${products}）`);
      }
      await emit({
        kind: result.success ? "pipeline.finished" : "pipeline.failed",
        projectId: input.projectId,
        runId,
        payload: { stages: Object.keys(result.stages ?? {}) }
      });
      return result;
    } catch (err) {
      await emit({
        kind: "pipeline.failed",
        projectId: input.projectId,
        runId,
        payload: { error: err instanceof Error ? err.message : String(err) }
      });
      throw err;
    } finally {
      uninstallInnerDiagnostics();
      uninstallDiscoveryFix();
      uninstallPromptRebuild();
      uninstallContract();
      uninstallMicroMotion();
      uninstallFieldQuality();
      uninstallPhaseDiagnostics();
      uninstallIsolator();
      uninstall();
    }
  }
}
