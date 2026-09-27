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
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWithConfirmationHandler, type ConfirmationHandler } from "./confirmation.js";
import { resolveGate, type GateVerdict } from "./gates.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import { createPortraitRuntime, type PortraitRuntimeOptions } from "./portrait-runtime.js";
import {
  applyDurationPolicyToManager,
  installVendorAudioDisciplineBridge,
  installVendorConfigIsolatorBridge,
  installVendorContractBridge,
  installVendorDurationPolicyBridge,
  installVendorDurationProjectionBridge,
  installVendorFieldQualityBridge,
  installVendorMicroMotionBridge,
  installVendorDiscoveryFixBridge,
  installVendorPhaseInternalsDiagnostics,
  installVendorPhaseDiagnosticsBridge,
  installVendorPromptRebuildBridge,
  installSharedBridge
} from "./vendor-compat.js";
import { AUDIO_DISCIPLINE_CLAUSE, AUDIO_NEGATIVE_TERMS } from "./shot-spec.js";
import { loadDurationRules } from "./duration-rules.js";

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
    | "pipeline.duration.projected"
    | "pipeline.duration.infeasible"
    | "pipeline.duration.skipped"
    | "pipeline.duration.package_check"
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
  /**
   * 镜头时长策略（2026-09-23）：默认从媒体目录读取模型能力（Seedance 2.5 实测 4–30s），
   * 并把 vendor 的三处 15s 口径统一放宽，避免"计划能拍、提交被拒"或节奏被悄悄夹紧。
   */
  durationPolicy?: { maxSingleShotSeconds?: number; minSingleShotSeconds?: number };
  /**
   * 商品情报档案（Stage -2 · 珍妮纺织机）运行参数（2026-09-25 激活）。
   *
   * 为什么要有：vendor 的情报层是**数据驱动**的（`metadata.dataMining` / `metadata.brief.product`
   * 存在才跑），而 `spec` 模式且无 executor 时只产出《采集任务书》、不产档案——宿主此前
   * 两样都没接，于是营销片实际等于叙事片跑法。这里把四个运行开关显式透传给 vendor：
   *
   *  - `mode`：`spec`（出任务书，等执行方回填）| `api`（注入 executor 全自动五站）；
   *  - `executor`：api 模式的检索执行器（宿主实现，见 apps/server/src/video/data-mining-executor.ts）；
   *  - `refresh`：命中旧档案也强制重跑（默认复用未过期档案，30 天 stale）；
   *  - `raw`：执行方已完成回填时直接装订（免重复检索）；
   *  - `storeRoot`：档案落盘根（缺省 `<workDir>/dossiers`，按工作区隔离）。
   */
  dataMining?: {
    mode?: "spec" | "api";
    executor?: (stage: string, plan: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    refresh?: boolean;
    raw?: Record<string, unknown>;
    storeRoot?: string;
    staleAfterDays?: number;
    /** 仅服务宿主在完整来源/G1通过后装配；浏览器metadata中的同名字段没有权限。 */
    verifiedRaw?: { projectId: string; rawJson: string; sha256: string; productQuery: Record<string, unknown> };
  };
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
    const metadata = structuredClone(input.metadata ?? {});
    delete metadata._dataDossier;
    const verified = cfg.dataMining?.verifiedRaw;
    let verifiedRaw: Record<string, unknown> | undefined;
    if (input.isMarketing) {
      if (!verified || verified.projectId !== input.projectId || createHash("sha256").update(verified.rawJson).digest("hex") !== verified.sha256) {
        throw new Error("MARKETING_G1_REQUIRED：营销创意只能消费本次宿主G1通过的事实回填");
      }
      const parsed = JSON.parse(verified.rawJson) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || ["A1", "A2", "A3"].some(stage => !parsed[stage] || typeof parsed[stage] !== "object")) {
        throw new Error("MARKETING_G1_REQUIRED：本次事实回填未覆盖三站");
      }
      if (!verified.productQuery || typeof verified.productQuery.name !== "string" || !verified.productQuery.name.trim()
        || Object.keys(verified.productQuery).some(key => !["name", "brand", "category", "model"].includes(key))) {
        throw new Error("MARKETING_G1_REQUIRED：商品查询必须来自本次已审事实包");
      }
      metadata.dataMining = structuredClone(verified.productQuery);
      verifiedRaw = parsed;
    }
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

    return runWithConfirmationHandler(handler, async () => {
      const disposers: Array<() => void> = [];
      const keep = (dispose: () => void): void => { disposers.push(dispose); };
      let runFailure: { error: unknown } | undefined;
      try {
        /**
         * 注入依赖保活（vendor ConfigIsolator 会摊平类实例，见 vendor-compat.ts）：
         * 必须在本实例装配之前打上，否则注入的 LLM 引擎在隔离后变成"空心对象"，
         * 链路最开头的创意主题生成器会静默降级成规则兜底（真机 2026-09-22 事故）。
         */
        keep(installVendorConfigIsolatorBridge());
        /** 阶段异常栈诊断：Phase 3/3.5 失败时把栈写进 run 日志（vendor 只打 message，真机无法定位行号） */
        keep(installVendorPhaseDiagnosticsBridge({ log }));
        /**
         * 字段质检桥：Phase 3.5 对结构化 timeline 崩 `tl.match` / `result.reports` 缺失导致整套质检失败
         * （真机：FieldGuard 默认模板覆盖 6 镜并标记降级）。入参归一 + 结果兜底。
         */
        keep(installVendorFieldQualityBridge({ log }));
        /**
         * 微动作桥：`_extractCameraDistance` 只读 `camera`（实际字段是 camera_movement）+ 模板缺 neutral
         * → 真机两次 run 均 0/6 增强（环节空转）。补齐字段映射与 neutral 模板。
         */
        keep(installVendorMicroMotionBridge({ log }));
        /**
         * 契约桥：Phase1→2/2→3/3→Output 的类型不匹配此前只告警（且 autoFix 对逐镜头字段不生效），
         * 导致对象字段以 `[object Object]` 进入提示词。这里做入参归一 + 契约账本留痕。
         */
        keep(installVendorContractBridge({ log }));
        /**
         * 提示词重建桥：Phase 3 失败（真机 `Assignment to constant variable.`）时 6 镜 prompt 为空，
         * 最终被 PipelineGuard 严格模式拦下、整条 run 无产物。用 vendor 自己的组装器按字段重建，
         * 并标记 promptRebuilt（非静默兜底）。
         */
        keep(installVendorPromptRebuildBridge({ log }));
        /** 需求洞察 _fillDefaults 修复（数组保形 + 消除 const 重赋值，静态审计发现） */
        keep(installVendorDiscoveryFixBridge({ log }));
        /** Phase 3 后融合链路深栈诊断（vendor 内部 catch 会吞掉栈帧） */
        keep(installVendorPhaseInternalsDiagnostics({ log }));
        /** 镜头内音频纪律（禁止 BGM）与时长策略（模型能力 4–30s）两条产品口径 */
        keep(installVendorAudioDisciplineBridge({
          clause: AUDIO_DISCIPLINE_CLAUSE,
          negativeTerms: AUDIO_NEGATIVE_TERMS,
          log
        }));
        const durationRules = loadDurationRules();
        const maxSingleShot = cfg.durationPolicy?.maxSingleShotSeconds ?? durationRules.modelMax;
        const minSingleShot = cfg.durationPolicy?.minSingleShotSeconds ?? durationRules.modelMin;
        /**
         * 桥按"进程级共享 + 引用计数"安装（T-2026-0925-0001）：
         * 预生产 run 允许并发，而桥是进程全局的；若每个 run 各自装卸，
         * 先结束的 run 会把仍在运行的 run 的补丁一起还原（时长口径中途分裂）。
         */
        keep(installSharedBridge("vendor-duration-policy", () =>
          installVendorDurationPolicyBridge({
            maxSingleShotSeconds: maxSingleShot,
            minSingleShotSeconds: minSingleShot,
            log
          })
        ));
        /**
         * 镜头时长单点守恒投影桥（T-2026-0925-0001）：
         * 把 vendor 的四处时长决策（剧本总量对齐 / 制作归一 / 运行期约束 / 台词修复后的重排）
         * 全部收敛到宿主投影器；`WORKLOOM_DURATION_PROJECTION=off` 可一键回到原行为（回滚开关）。
         */
        const projectionEnabled = (process.env.WORKLOOM_DURATION_PROJECTION ?? "on") !== "off";
        let lastProjectedTarget: number | null = null;
        keep(projectionEnabled
          ? installSharedBridge("vendor-duration-projection", () =>
              installVendorDurationProjectionBridge({
                minShotSeconds: minSingleShot,
                maxShotSeconds: maxSingleShot,
                log,
                onEvent: (event) => {
                  if (typeof event.targetSeconds === "number" && event.targetSeconds > 0) {
                    lastProjectedTarget = event.targetSeconds;
                  }
                  void emit({
                    kind: `pipeline.duration.${event.kind}`,
                    projectId: input.projectId,
                    runId,
                    payload: {
                      source: event.source,
                      targetSeconds: event.targetSeconds,
                      totalSeconds: event.totalSeconds,
                      raised: event.shots.filter((shot) => shot.raised).map((shot) => shot.shotId),
                      lowered: event.shots.filter((shot) => shot.lowered).map((shot) => shot.shotId),
                      message: event.message ?? null
                    }
                  });
                  if (event.kind !== "projected") {
                    log(`[studio] 时长投影 ${event.kind}（${event.source}）：${event.message ?? ""}`);
                  }
                }
              })
            )
          : () => undefined);
        if (!projectionEnabled) log("[studio] 时长投影桥已按 WORKLOOM_DURATION_PROJECTION=off 关闭（回滚态）");
        log(
          `[studio] 时长策略：单镜 ${minSingleShot}–${maxSingleShot}s（模型目录口径，Seedance 2.5 实测上限 30s）`
          + `；口径清单 ${durationRules.sources.length} 条（在用 ${durationRules.sources.filter((s) => s.live).length} / 未接线 ${durationRules.nonLive.length}）`
        );
        if (!durationRules.aligned) {
          log(
            `[studio] ⚠️ 仍有在用口径低于模型上限：`
            + durationRules.blockers.map((b) => `${b.id}=${b.value}s`).join("；")
          );
        }

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
          charactersDir,
          durationConstraint: { maxSingleShot, minSingleShot }
        });
        /** 实例级放宽 rhythmProfiles（standard 12 / slow 15 → 模型上限），否则 30s 单镜会被重新夹紧 */
        applyDurationPolicyToManager(
          (system as unknown as { durationConstraintManager?: unknown }).durationConstraintManager,
          maxSingleShot,
          minSingleShot
        );

        await emit({ kind: "pipeline.started", projectId: input.projectId, runId: null });
        /**
         * vendor create 的第三参是"运行期开关"（batchMode/portraitExecutor/portraitRuntime/dryRun/skipRender）。
         * deferRender=true 时 Layer 3 不提交（渲染由宿主 render-operator 走 G8 围栏提交），
         * 避免 vendor 与宿主对同一批镜头各提交一次、双份烧额度。
         */
        const createOptions: Record<string, unknown> = {};
        if (cfg.deferRender === true) createOptions.skipRender = true;
        /**
         * 商品情报档案（Stage -2）开关透传：只有宿主显式装配才生效，
         * 未装配时 vendor 保持原有行为（spec 模式出任务书、不落档案）。
         */
        if (cfg.dataMining) {
          createOptions.dataMiningMode = cfg.dataMining.mode ?? "api";
          createOptions.dataMiningStoreRoot = cfg.dataMining.storeRoot
            ?? path.join(cfg.workDir, "dossiers");
          if (cfg.dataMining.executor) createOptions.dataMiningExecutor = cfg.dataMining.executor;
          if (cfg.dataMining.refresh) createOptions.dataMiningRefresh = true;
          if (cfg.dataMining.raw) createOptions.dataMiningRaw = cfg.dataMining.raw;
          if (cfg.dataMining.staleAfterDays) createOptions.dataMiningStaleDays = cfg.dataMining.staleAfterDays;
          log(
            `[studio] 商品情报档案已装配：mode=${String(createOptions.dataMiningMode)}`
            + `${cfg.dataMining.executor ? " + 真实检索执行器" : "（无执行器：只出采集任务书）"}`
            + `；档案根 ${String(createOptions.dataMiningStoreRoot)}`
          );
        }
        if (verifiedRaw) {
          createOptions.dataMiningRaw = verifiedRaw;
          createOptions.dataMiningRefresh = true;
          // G1已经由宿主在vendor.create之前评审；不受portrait batchMode影响，也不再次挑选旧缓存。
          createOptions.skipDataMiningReview = true;
        }
        if (portraitRuntime) {
          createOptions.batchMode = true;
          createOptions.portraitExecutor = "api";
          createOptions.portraitRuntime = portraitRuntime;
          const modelName = portraitCfg && portraitCfg.enabled !== false ? portraitCfg.model : "未指定模型";
          log(`[studio] 定妆照真实出图已启用（${modelName}，产物根 ${charactersDir}）`);
        }
        const result = await system.create(input.intent, metadata, createOptions);
        if (portraitRuntime) {
          const index = portraitRuntime.snapshot();
          const characters = Object.keys(index.characters).length;
          const products = Object.keys(index.products).length;
          log(`[studio] 定妆照索引落盘：${portraitRuntime.indexPath()}（角色 ${characters} / 商品 ${products}）`);
        }
        /**
         * 作品级校验（T-2026-0925-0001，问题 P10）：
         * vendor 的 `PromptDeliveryGuard.verifyPackage`（片头在场 / 平台时长带 / 禁全部同长 / 总时长 ±15%）
         * 此前**全仓 0 处调用**，等于不存在；这里在预生产产物返回后、宣告 finished 之前补上，
         * 结果落 `pipeline.duration.package_check` 事件（只报告不阻断；阻断由渲染提交侧负责）。
         */
        try {
          const shots = (
            (result?.stages?.productionEngine as { shots?: Array<Record<string, unknown>> } | undefined)?.shots ?? []
          ).filter((shot) => Number(shot.duration ?? 0) > 0);
          if (shots.length > 0) {
            const guardMod = createRequire(import.meta.url)(
              path.resolve(
                fileURLToPath(new URL(".", import.meta.url)),
                "../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-delivery-guard.js"
              )
            ) as { PromptDeliveryGuard: new () => { verifyPackage: (list: unknown[], options?: Record<string, unknown>) => { pass: boolean; issues: string[] } } };
            const check = new guardMod.PromptDeliveryGuard().verifyPackage(shots, {
              targetDuration: lastProjectedTarget ?? undefined
            });
            await emit({
              kind: "pipeline.duration.package_check",
              projectId: input.projectId,
              runId,
              payload: {
                pass: check.pass,
                issueCount: check.issues.length,
                issues: check.issues.slice(0, 20),
                targetSeconds: lastProjectedTarget,
                shots: shots.length,
                totalSeconds: shots.reduce((sum, shot) => sum + Number(shot.duration ?? 0), 0)
              }
            });
            if (!check.pass) {
              log(`[studio] ⚠️ 作品级时长校验未通过（${check.issues.length} 项）：${check.issues.slice(0, 5).join("；")}`);
            }
          }
        } catch (err) {
          log(`[studio] 作品级校验跳过：${err instanceof Error ? err.message : String(err)}`);
        }
        await emit({
          kind: result.success ? "pipeline.finished" : "pipeline.failed",
          projectId: input.projectId,
          runId,
          payload: { stages: Object.keys(result.stages ?? {}) }
        });
        return result;
      } catch (err) {
        runFailure = { error: err };
        await emit({
          kind: "pipeline.failed",
          projectId: input.projectId,
          runId,
          payload: { error: err instanceof Error ? err.message : String(err) }
        });
        throw err;
      } finally {
        const cleanupErrors: unknown[] = [];
        for (const dispose of disposers.reverse()) {
          try {
            dispose();
          } catch (err) {
            cleanupErrors.push(err);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [...(runFailure ? [runFailure.error] : []), ...cleanupErrors],
            "video-studio-bridge-cleanup-failed"
          );
        }
      }
    });
  }
}
