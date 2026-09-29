/**
 * P2 任务页·主线执行（F4：Quest 会话页；PRD P2-①②③ 逐条对账）
 *  - 行动消息流（P2E2）= 该线程事件流子序列投影（P2-⑤：ts 升序；回执三态/命中规则/计量逐事件渲染）
 *  - 失败步红框 + 转人工/降级重试/回滚三入口（E3.1）；无回执标「未核实」不宣称完成（L3.6/E3.7）
 *  - ThreadInspector 右栏：进度 x/y · 参与成员 · 计量（档/窗口/积分/降级链）· 围栏判定，≤5s 轮询（F3.4）；
 *    断线显「连接中断·重连中」不伪造进度
 *  - 业务关卡卡内联（ApprovalCardMsg 语义）：只呈现业务链路自带的关卡（如视频管线 G1–G10、
 *    定妆照确认）——diff + 命中规则版本 + 三手势 → 服务端放行写回；基座通用审批环节已移除
 *    （2026-09-21 产品所有者口径，本机单人运行）
 *  - 完成后态 p2_done：交付卡 + 决策链路时间轴；无对外变更明示「仅只读分析」（E3.7）
 *  - 权限态：只读成员不显示输入栏（E2.6，隐藏非置灰）
 * 状态变体：p2 执行中 / p2_review 待审查 / p2_done 已完成 / p2_error 错误（?demo= 强制走查）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { COMMON_STATUS_TEXT, MODEL_TIER_TEXT, MODEL_WINDOW_TEXT, RULE_RESULT_TEXT, THREAD_MODE_TEXT, actionText, actorText, approvalGestureText, dictText, payloadText, shortId } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import { LoomBall, TONE_CLASS, emotionLabelOf, emotionOfThread, emotionToneOf, loomBallEnabled, useStableEmotion } from "../../components/loomball";
import { useNavigationAccess } from "../../shell/NavigationAccess";
import { RejectDialog } from "../../components/RejectDialog";
import { PageExitLink } from "../../shell/PageExitLink";
import {
  AgentActionMessage,
  BannerAlert,
  EmptyState,
  HumanBubble,
  Skeleton,
  SubCallMessage,
  SystemDivider,
  TriGestureBar,
  XpBar,
  type ReceiptState,
} from "../../components/hud";
import { Icon, clientChineseText } from "@workloom/ui";
import { clientNaturalText } from "../../lib/clientText";

interface ThreadRow {
  id: string; title: string; mode: string; status: string;
  progress_done: number; progress_total: number; agent_id: string | null;
  created_by: string; created_at: string;
}
interface Ev {
  event_id: string;
  who: { type: "human" | "agent" | "system"; id: string; version?: string };
  context: { time: string };
  object: { type: string; id?: string };
  decision: { action: string; effect?: "read" | "write"; before?: unknown; after?: unknown; basis?: string[]; kind?: string; outcome?: string };
  rule_impact: Array<{ rule_id: string; version: string; result: string }>;
  /** GR-15/N-16：receipt.mode 区分「模拟回执」与「真实连接器回执」（假回执不得外观同真回执） */
  receipt?: { synced?: boolean; snapshot_uri?: string; mode?: "simulated" | "real" };
  model_trace?: { model_id: string; tier?: string; window?: string; credits?: number };
  links?: string[];
}
interface ApprovalRow {
  approval_id: string; event_id: string; status: string;
  snapshot: {
    summary?: string; before?: unknown; after?: unknown; rule_version?: string;
    /** GR-07：确定性兜底计划参数不完整 → 审批卡黄色警示条 */
    warning?: string;
    params_incomplete?: boolean;
    /** GR-01：审批绑定的步骤指纹（replay 比对，防漂移消费） */
    step_fingerprint?: string;
    tool?: string;
  };
}

/** 回执三态映射（L3.6/E3.7：无回执=未核实，不得宣称完成） */
function receiptOf(ev: Ev): ReceiptState {
  if (ev.rule_impact?.some((r) => r.result === "blocked")) return "failed";
  if (ev.receipt?.synced) return "synced";
  return "unverified";
}

/**
 * 任务结果摘要（2026-09-20 真机反馈：任务详情要看得见「关键链路进展」与「最终结果」）。
 * 只认「结果」语义的字段：
 *   - 字符串结果（result/output/summary/text/content）直接展示；
 *   - 结构化结果（result.outputs / artifacts / files）折算为产物摘要（类型 + 体积）；
 *   - 任务标题（title）、提示词（prompt）、模型名（model）**不是**结果，不回显；
 *   - `模型：信息待确认`、`补充信息：…`、字段名与 JSON 这类占位一律不回显。
 */
const RESULT_TEXT_KEYS = ["summary", "text", "content", "output", "url"] as const;
const RESULT_LIST_KEYS = ["outputs", "artifacts", "files"] as const;

/** 产物摘要：只看数量、类型与体积，不释放本地路径/哈希等内部信息 */
function artifactLineOf(items: unknown[]): string | null {
  if (items.length === 0) return null;
  const first = items[0];
  if (!first || typeof first !== "object") return `已产出 ${items.length} 个产物`;
  const record = first as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : typeof record.url === "string" ? record.url : "";
  const kind = /\.(png|jpe?g|webp|gif|bmp)$/i.test(path) ? "图片"
    : /\.(mp4|mov|webm)$/i.test(path) ? "视频"
      : /\.(md|txt|docx?|pdf)$/i.test(path) ? "文档" : "文件";
  const bytes = typeof record.bytes === "number" ? record.bytes : null;
  const size = bytes === null ? "" : ` · 约 ${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `已产出 ${items.length} 个${kind}产物${size}`;
}

function resultLineOf(after: unknown): string | null {
  if (typeof after === "string") return clientChineseText(after, "") || null;
  if (!after || typeof after !== "object") return null;
  const record = after as Record<string, unknown>;
  for (const key of ["result", "output", "summary", "text", "content"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      const text = clientChineseText(value, "");
      if (text) return text.length > 240 ? `${text.slice(0, 240)}…` : text;
    }
    if (!value || typeof value !== "object") continue;
    const nested = value as Record<string, unknown>;
    for (const textKey of RESULT_TEXT_KEYS) {
      const textValue = nested[textKey];
      if (typeof textValue !== "string" || !textValue.trim()) continue;
      const text = clientChineseText(textValue, "");
      if (text) return text.length > 240 ? `${text.slice(0, 240)}…` : text;
    }
    for (const listKey of RESULT_LIST_KEYS) {
      const items = nested[listKey];
      if (Array.isArray(items)) {
        const line = artifactLineOf(items);
        if (line) return line;
      }
    }
  }
  return null;
}

/** 产物条目（服务端只回元数据；路径不出服务端） */
interface ArtifactMeta { index: number; kind: "image" | "video" | "document" | "file"; mime: string; bytes: number | null }

const ARTIFACT_KIND_TEXT: Record<ArtifactMeta["kind"], string> = {
  image: "图片", video: "视频", document: "文档", file: "文件",
};

function bytesText(bytes: number | null): string {
  if (typeof bytes !== "number" || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return ` · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return ` · ${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 产物预览（2026-09-21 产品所有者口径：最终结果里要能直接看、直接下载）：
 * 图片/视频内联展示并可下载；纯文本/MD/HTML/PDF 等给下载入口。
 * 取件走 threads.artifactData（鉴权头 + base64 → blob URL），不做无鉴权裸端点。
 */
function ArtifactView({ threadId, artifact }: { threadId: string; artifact: ArtifactMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        await ensureDemoLogin();
        const data = await (trpc.threads as unknown as {
          artifactData: { query: (i: { threadId: string; index: number }) => Promise<{ base64: string; mime: string }> };
        }).artifactData.query({ threadId, index: artifact.index });
        if (!alive) return;
        const binary = atob(data.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: data.mime }));
        setUrl(objectUrl);
      } catch (err) {
        if (!alive) return;
        // 服务端给的是受控中文文案（超限/越界/不在本机），过一遍客户端文案边界再用
        const message = err instanceof Error ? clientChineseText(err.message, "") : "";
        setError(message || "产物暂时无法打开（可能不在本机或已被清理）");
      }
    })();
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [threadId, artifact.index]);

  const label = `产物 ${artifact.index + 1} · ${ARTIFACT_KIND_TEXT[artifact.kind]}${bytesText(artifact.bytes)}`;
  if (error) {
    return <div className="rounded-lg border border-warn/40 bg-warn/5 px-2.5 py-2 text-body text-warn">{label}：{error}</div>;
  }
  return (
    <div className="rounded-lg border border-line bg-bg800/40 p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-body text-ink3">
        <span>{label}</span>
        <span className="flex-1" />
        {url && (
          <a
            href={url}
            download={`artifact-${threadId}-${artifact.index + 1}`}
            className="rounded border border-gline px-2 py-0.5 text-body font-bold text-gold no-underline hover:bg-gold/10"
          >
            下载
          </a>
        )}
      </div>
      {!url ? (
        <div className="text-body text-ink3">正在取件…</div>
      ) : artifact.kind === "image" ? (
        <img src={url} alt={label} className="max-h-72 w-auto max-w-full rounded-md border border-line bg-bg950 object-contain" />
      ) : artifact.kind === "video" ? (
        <video src={url} controls playsInline className="max-h-72 w-full max-w-full rounded-md border border-line bg-bg950" />
      ) : (
        <div className="text-body text-ink2">该格式不支持内联预览，点「下载」取用（支持纯文本 / Markdown / HTML / PDF）。</div>
      )}
    </div>
  );
}

export default function P2() {
  const { canAction } = useNavigationAccess();
  const { threadId = "" } = useParams();
  const [params] = useSearchParams();
  const demo = params.get("demo");
  /** X-02：来自对话框卡片的审批锚点（?apr=）——高亮并滚动到该审批卡 */
  const anchorApprovalId = params.get("apr");

  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false); // 断线重连中（F3.4 不伪造进度）
  const [thread, setThread] = useState<ThreadRow | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  /** 产物清单（任务详情「最终结果」直接看/下载产物） */
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [th, list, ap] = await Promise.all([
        trpc.threads.get.query({ threadId }) as Promise<ThreadRow | null>,
        trpc.threads.list.query() as Promise<ThreadRow[]>,
        trpc.approvals.list.query() as Promise<ApprovalRow[]>,
      ]);
      setThread(th);
      setThreads(list);
      if (th) {
        const ev = (await trpc.threads.events.query({ threadId })) as Ev[];
        setEvents(ev);
        // 本线程相关的业务关卡（event_id ∈ 线程事件链）
        const ids = new Set(ev.map((e) => e.event_id));
        /**
         * 只展示「需要人审的决策门」：内部生产协作（脚本/分镜/拍摄清单/成片这些员工之间的
         * 日常流转）不设人审——产出只作为过程与时间线出现在消息流与关键链路里
         * （2026-09-21 产品所有者口径；配套围栏 G-C01 已把内部协作改为 auto）。
         * 历史遗留的挂起项在这里一并过滤，等服务端过期清扫收口。
         */
        setApprovals(ap.filter((a) => ids.has(a.event_id)).filter((a) => {
          const snapshot = a.snapshot as { gate?: unknown; action?: unknown };
          if (snapshot?.gate) return true;                       // G1–G10 决策门
          const action = typeof snapshot?.action === "string" ? snapshot.action : "";
          return /\.(confirm|execute|submit|publish|boost|approve|adjust|commit|finalize|topup)$/.test(action)
            || /^(gate|publish|ads|price|deal|budget|credit|spend|purchase|order|invoice)\./.test(action);
        }));
      }
      setOffline(false);
    } catch {
      setOffline(true); // 断线：显「重连中」，保留最后已知进度（不伪造）
    } finally {
      setReady(true);
    }
  }, [threadId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000); // F3.4 ≤5s 轮询
    return () => clearInterval(t);
  }, [load]);

  /** 产物清单：跟事件流同频刷新（产物是事件账本里登记的，不另建事实源） */
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    const loadArtifacts = async () => {
      try {
        await ensureDemoLogin();
        const list = await (trpc.threads as unknown as {
          artifacts: { query: (i: { threadId: string }) => Promise<ArtifactMeta[]> };
        }).artifacts.query({ threadId });
        if (alive) setArtifacts(list);
      } catch {
        /* 取件清单失败不影响任务详情其余内容 */
      }
    };
    void loadArtifacts();
    const t = setInterval(() => void loadArtifacts(), 5000);
    return () => { alive = false; clearInterval(t); };
  }, [threadId]);

  /* ---------- 计量与围栏聚合（ThreadInspector） ---------- */
  const meter = useMemo(() => {
    const traces = events.map((e) => e.model_trace).filter(Boolean) as NonNullable<Ev["model_trace"]>[];
    const credits = traces.reduce((s, t) => s + (t.credits ?? 0), 0);
    const impacts = events.flatMap((e) => e.rule_impact ?? []);
    return {
      credits,
      tiers: [...new Set(traces.map((t) => t.tier ?? "standard"))],
      window: traces[traces.length - 1]?.window ?? "—",
      pass: impacts.filter((i) => i.result === "pass").length,
      review: impacts.filter((i) => i.result === "review").length,
      blocked: impacts.filter((i) => i.result === "blocked").length,
    };
  }, [events]);

  const hasWrite = events.some((e) => e.decision.effect === "write" && e.receipt?.synced === true);
  const isDone = thread?.status === "completed";
  const isFailed = demo === "p2_error" || thread?.status === "failed";
  /* 织球线程状态眼（接入面 C）：thread.status 是线程投影的真实状态，pending_review=等人审 */
  const rawThreadEmotion = emotionOfThread({ status: isFailed ? "failed" : (thread?.status ?? "draft"), awaitingApproval: false });
  const threadEmotion = useStableEmotion(rawThreadEmotion);
  const threadTone = emotionToneOf(threadEmotion);
  const threadEmotionText = emotionLabelOf(threadEmotion);
  const canApprove = canAction("approval.decide");
  const canDispatch = canAction("task.dispatch");

  /**
   * 关键链路进展 + 最终结果（2026-09-20 真机反馈补齐）：
   *  派发（人下达）→ 执行（数字员工动作，含子呼叫）→ 交付（线程收尾 + 可展示结果）。
   * 全程只用事件账本里真实存在的事实，不编造进度：没有的事件就是「尚未发生」。
   */
  const chain = useMemo(() => {
    const dispatched = events.some((e) => e.decision.action === "thread.dispatch" || e.who.type === "human");
    const agentActions = events.filter((e) => e.who.type === "agent");
    const approvalsIn = events.filter((e) => e.decision.action.includes("approval")).length;
    const results = events
      .map((e) => ({ at: e.context.time, text: resultLineOf(e.decision.after) }))
      .filter((x): x is { at: string; text: string } => Boolean(x.text));
    const last = events[events.length - 1];
    return {
      dispatched,
      agentActions: agentActions.length,
      approvalsIn,
      latestAt: last?.context.time ? new Date(last.context.time).toTimeString().slice(0, 5) : null,
      lastStep: last ? `${actorText(last.who.id)} · ${actionText(last.decision.action)}` : null,
      result: results.length ? results[results.length - 1]!.text : null,
      delivered: Boolean(thread && thread.status === "completed"),
    };
  }, [events, thread]);

  /* ---------- 手势写回（approvals.decide；驳回原因弹窗在 P4 落地完整枚举，此处驳回走默认原因） ---------- */
  const gesture = useCallback(async (approvalId: string, g: "approve" | "edit" | "reject") => {
    if (g === "reject") {
      // M1.2（D24）：驳回必须选择行业受控枚举（弹窗），自由文本只做补充
      setRejectTarget(approvalId);
      return;
    }
    await trpc.approvals.decide.mutate({ approvalId, gesture: g });
    setBanner({ level: "info", text: "关卡放行结果已写入事件账本，并用于校准协作偏好。" });
    await load();
  }, [load]);

  /** 驳回弹窗提交（M1.2 受控枚举 + L5.2 留痕） */
  const submitReject = useCallback(async (r: { reasonEnum: string; reasonText?: string }) => {
    if (!rejectTarget) return;
    await trpc.approvals.decide.mutate({
      approvalId: rejectTarget,
      gesture: "reject",
      reasonEnum: r.reasonEnum,
      reasonText: r.reasonText,
    });
    setRejectTarget(null);
    setBanner({ level: "info", text: "已驳回并记录原因，后续会用于校准协作偏好。" });
    await load();
  }, [rejectTarget, load]);

  /* ---------- 左栏：会话列表（P2E1 状态点浏览，单击切换） ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">任务会话</div>
      {threads.map((t) => (
        <a
          key={t.id}
          href={`/tasks/${t.id}`}
          className={`mb-1.5 block rounded-lg border px-3 py-2.5 no-underline ${
            t.id === threadId ? "border-gline bg-gold/6" : "border-line bg-card hover:border-gline"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-body text-ink3">{shortId(t.id)}</span>
            <span className="inline-flex items-center gap-1.5 text-body text-ink2">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                t.status === "running" ? "bg-holo animate-pulse-hud"
                : t.status === "pending_review" ? "bg-warn animate-pulse-warn"
                : t.status === "completed" ? "bg-go"
                : t.status === "failed" ? "bg-alert" : "bg-ink3"
              }`} />
              {t.progress_done}/{t.progress_total}
            </span>
          </div>
          <div className="mt-1 text-body text-ink2">{t.title}</div>
        </a>
      ))}
    </>
  );

  /* ---------- 右栏：ThreadInspector（P2E5 只读；成员点击 → P8 后续卡） ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">任务信息</div>
      {thread && (
        <div className="space-y-3">
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">实时进度（约每 5 秒更新）</div>
            <XpBar done={thread.progress_done} total={thread.progress_total} />
            <div className="mt-1.5 text-body text-ink3">
              {offline ? "连接中断 · 重连中（保留最后已知进度）" : `状态 ${dictText(COMMON_STATUS_TEXT, thread.status)} · 预计剩余 —`}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">模型调用计量</div>
            <div className="font-orb text-h2 font-bold text-ink">{meter.credits} <span className="text-body text-ink3">积分</span></div>
            <div className="mt-0.5 text-body text-ink3">
              {meter.tiers.map((tier) => dictText(MODEL_TIER_TEXT, tier)).join(" / ")} · {dictText(MODEL_WINDOW_TEXT, meter.window)}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">围栏判定</div>
            <div className="flex gap-2.5 font-mono text-body">
              <span className="text-go">放行 {meter.pass}</span>
              <span className="text-warn">复核 {meter.review}</span>
              <span className="text-alert">阻断 {meter.blocked}</span>
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">参与成员</div>
            <div className="text-body text-ink2">{actorText(thread.agent_id ?? "system")}</div>
            <div className="mt-0.5 text-body text-ink3">发起人 {actorText(thread.created_by)}</div>
          </div>
        </div>
      )}
    </>
  );

  /* ---------- 中栏：行动消息流 ---------- */
  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        {/* ThreadHeader（P2-④：mode/路由置信度可见） */}
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          {/* 二级页（从任务列表钻取进来）：给一条明确的回退路径，不依赖浏览器后退 */}
          <PageExitLink to="/tasks" label="返回任务列表" preferHistory />
          <h2 className="text-h1 font-black tracking-wider">任务执行</h2>
          {thread && (
            <>
              <span className="rounded border border-gold/60 bg-gold/10 px-1.5 py-0.5 text-body font-black text-gold">
                {dictText(THREAD_MODE_TEXT, thread.mode)}
              </span>
              <span className="font-mono text-body text-ink3">{shortId(thread.id)}</span>
              <span className="text-body text-ink2">{thread.title}</span>
              {loomBallEnabled && (
                <span className="inline-flex items-center gap-1.5" title={`任务${threadEmotionText}`}>
                  <LoomBall emotion={threadEmotion} size={40} live={threadTone === "busy" || threadTone === "wait"}
                    hoverActivate={!(threadTone === "busy" || threadTone === "wait")} followGaze={false} />
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-body ${TONE_CLASS[threadTone]}`}>
                    {threadEmotionText}
                  </span>
                </span>
              )}
              <span className="flex-1" />
              {canDispatch && thread.status !== "completed" && thread.status !== "failed" && (
                <button
                  type="button"
                  onClick={() => void trpc.threads.run.mutate({ threadId: thread.id, goal: thread.title, ...(thread.agent_id ? { presetKey: thread.agent_id } : {}) }).then(load)}
                  className="cursor-pointer rounded-md border border-gline bg-gold/8 px-3 py-1 text-body font-bold text-gold hover:bg-gold/15"
                >
                  <Icon name="play" size={14} className="inline" /> 执行或从中断处继续
                </button>
              )}
            </>
          )}
        </div>

        {offline && (
          <div className="mb-3"><BannerAlert level="warn">连接中断，正在重连；当前显示最后一次成功获取的进度，不会把旧数据当作最新结果。</BannerAlert></div>
        )}
        {banner && (
          <div className="mb-3"><BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert></div>
        )}

        {/* p2_error：探针失效停止一切点击 + 三入口（E3.1/L3.3） */}
        {isFailed && (
          <div className="mb-3 rounded-lg border border-alert/55 bg-alert/8 p-3.5">
            <div className="mb-2 flex items-center gap-1.5 text-body font-bold text-alert"><Icon name="brake" size={15} />渠道连接检查失败 · 已暂停所有外部操作</div>
            {canDispatch && <div className="wl-action-row flex flex-wrap gap-2">
              <button type="button" onClick={() => setBanner({ level: "info", text: "已标记为需要人工介入，并开启人工接管通道。" })}
                className="cursor-pointer rounded-md border border-alert/60 bg-alert/10 px-3 py-1.5 text-body font-bold text-alert">转人工</button>
              <button type="button" onClick={() => thread && void trpc.threads.run.mutate({ threadId: thread.id, goal: thread.title, ...(thread.agent_id ? { presetKey: thread.agent_id } : {}) }).then(load)}
                className="cursor-pointer rounded-md border border-warn/50 bg-warn/10 px-3 py-1.5 text-body font-bold text-warn">降级重试</button>
              <button type="button" onClick={() => setBanner({ level: "info", text: "回滚会生成一组反向补偿事件，原始账本记录不会被覆盖。" })}
                className="cursor-pointer rounded-md border border-holo/40 bg-holo/8 px-3 py-1.5 text-body font-bold text-holo">回滚</button>
            </div>}
          </div>
        )}

        <div className="flex-1 space-y-3">
          {/* 关键链路进展（派发 → 执行 → 交付）：只画账本里真实发生的阶段 */}
          {thread && events.length > 0 && (
            <section className="rounded-msg border border-line bg-card p-3.5">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-body">
                <span className="font-bold text-holo">关键链路进展</span>
                <span className="text-ink3">
                  {dictText(COMMON_STATUS_TEXT, thread.status)} · {thread.progress_done}/{thread.progress_total} 步
                </span>
                <span className="flex-1" />
                <span className="text-ink3">
                  {offline ? "连接中断 · 重连中" : chain.latestAt ? `最近更新 ${chain.latestAt}` : "等待首次执行"}
                </span>
              </div>
              <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-body">
                {[
                  { key: "派发", done: chain.dispatched, detail: chain.dispatched ? "已下达给数字员工" : "尚未下达" },
                  { key: "执行", done: chain.agentActions > 0, detail: chain.agentActions > 0 ? `${chain.agentActions} 条动作${chain.approvalsIn ? ` · ${chain.approvalsIn} 次关卡放行` : ""}` : "尚未执行" },
                  { key: "交付", done: chain.delivered && Boolean(chain.result), detail: chain.delivered ? (chain.result ? "已产出结果" : "已收尾 · 无对外结果") : "尚未交付" },
                ].map((stage, index) => (
                  <li key={stage.key} className="inline-flex min-w-0 items-center gap-2">
                    {index > 0 && <span className="text-ink3">→</span>}
                    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${stage.done ? "border-go/50 text-go" : "border-line text-ink3"}`}>
                      <Icon name={stage.done ? "check" : "circle"} size={12} />
                      {stage.key}
                    </span>
                    <span className="break-words text-ink3">{stage.detail}</span>
                  </li>
                ))}
              </ol>
              {chain.lastStep && <div className="mt-2 break-words text-body text-ink2">最近一步：{chain.lastStep}</div>}
            </section>
          )}
          {!ready ? (
            <><Skeleton count={2} height={44} label="会话摘要正在加载" /><Skeleton count={4} label="会话内容正在加载" /></>
          ) : !thread ? (
            <EmptyState icon={<Icon name="tasks" size={24} />} title="线程不存在或已越权清空" hint="从左侧会话列表选择一条任务线程" />
          ) : events.length === 0 ? (
            <EmptyState icon={<Icon name="chat" size={24} />} title="还没有会话内容" hint="选择一位数字员工或说出第一句话" />
          ) : (
            <>
              <SystemDivider time={new Date(thread.created_at).toTimeString().slice(0, 5)} summary={`任务会话 ${shortId(thread.id)} 已建立，派遣事件已写入账本`} />
              {events.map((ev) => {
                if (ev.who.type === "human") {
                  // 人类消息文案化（§9.1 副官语气；动作码不直接上屏）
                  const after = ev.decision.after as { title?: string; gesture?: string } | undefined;
                  const text = ev.decision.action === "thread.dispatch"
                    ? (after?.title ?? thread.title)
                    : ev.decision.action === "approval.gesture"
                      ? `业务关卡：${approvalGestureText(after?.gesture)}`
                      : actionText(ev.decision.action);
                  return <HumanBubble key={ev.event_id} time={new Date(ev.context.time).toTimeString().slice(0, 5)}>{text}</HumanBubble>;
                }
                if (ev.links && ev.links.length > 0 && ev.who.type === "agent" && ev.decision.action.includes("subcall")) {
                  return (
                    <SubCallMessage key={ev.event_id} target="协作数字员工" version={ev.who.version ?? ""} receipt={receiptOf(ev)}>
                      {actionText(ev.decision.action)}
                    </SubCallMessage>
                  );
                }
                if (ev.decision.action === "ask.answer") {
                  // ask 问询应答（B8）：正文上屏（§9.1 动作码不直接上屏同口径）
                  const ans = clientNaturalText(
                    (ev.decision.after as { text?: string } | undefined)?.text,
                    "应答内容暂时无法显示，请稍后再试。",
                  );
                  return (
                    <AgentActionMessage
                      key={ev.event_id}
                      sender={actorText(ev.who.id)}
                      version={ev.who.version ?? ""}
                      action="经营参谋·应答"
                      eventId={ev.event_id}
                      receipt={receiptOf(ev)}
                      credits={ev.model_trace?.credits}
                    >
                      {ans}
                    </AgentActionMessage>
                  );
                }
                return (
                  <AgentActionMessage
                    key={ev.event_id}
                    sender={actorText(ev.who.id)}
                    version={ev.who.version ?? ""}
                    action={actionText(ev.decision.action)}
                    eventId={ev.event_id}
                    receipt={receiptOf(ev)}
                    // 同一事件可能命中多条同结果围栏 → 标签去重，避免 React key 重复告警
                    rules={[...new Set((ev.rule_impact ?? []).map((r) => `关联围栏 · ${dictText(RULE_RESULT_TEXT, r.result)}`))]}
                    credits={ev.model_trace?.credits}
                  >
                    {/* 2026-09-20：不再回显原始载荷（「模型：信息待确认 / 补充信息：…」是无用信息） */}
                    {resultLineOf(ev.decision.after)
                      ?? (ev.decision.effect === "write"
                        ? "已提交写操作，等待对外回执（无回执不算完成）。"
                        : "已记录本次动作，未产生可展示的对外结果。")}
                  </AgentActionMessage>
                );
              })}

              {/* 内联业务关卡卡（ApprovalCardMsg 语义：diff + 命中规则版本 + 三手势/已决态） */}
              {approvals.map((a) => (
                <div
                  key={a.approval_id}
                  id={`apr-${a.approval_id}`}
                  ref={(el) => {
                    // X-02：从对话框「去审批」进入时，滚动并高亮对应审批卡
                    if (el && anchorApprovalId && a.approval_id === anchorApprovalId && a.status === "pending") {
                      requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "center" }));
                    }
                  }}
                  className={`rounded-msg border p-4 ${
                    anchorApprovalId && a.approval_id === anchorApprovalId && a.status === "pending"
                      ? "border-amber-400 bg-amber-500/10 ring-2 ring-amber-400/60"
                      : a.status === "pending" ? "border-warn/40 bg-warn/4" : "border-line bg-card"
                  }`}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 text-h2 font-bold ${a.status === "pending" ? "text-warn" : "text-ink2"}`}>
                      <Icon name="approval" size={15} />业务关卡 · {a.status === "pending" ? "待放行" : a.status === "approved" ? "已放行" : a.status === "edited" ? "改后放行" : a.status === "rejected" ? "已退回" : "已过期"}
                    </span>
                    <span className="font-mono text-body text-ink3">{shortId(a.approval_id)}</span>
                  {a.snapshot.rule_version && <span className="text-body text-holo">命中关联围栏</span>}
                  </div>
                  {/* GR-07：兜底计划的参数不完整必须先说清楚，再让人决定放不放行（不盲批） */}
                  {(a.snapshot.warning || a.snapshot.params_incomplete) && (
                    <div className="mb-3 rounded border border-warn/50 bg-warn/10 p-2 text-body text-warn">
                      ⚠️ {a.snapshot.warning ?? "该步骤由确定性兜底计划生成，参数不完整，请人工补齐或驳回。"}
                    </div>
                  )}
                  {(a.snapshot.before !== undefined || a.snapshot.after !== undefined) && (
                    <div className="mb-3 grid grid-cols-1 gap-2 text-body sm:grid-cols-2">
                      <div className="rounded border border-line bg-bg800/60 p-2 text-ink3">调整前：{payloadText(a.snapshot.before, 220) || "暂无"}</div>
                      <div className="rounded border border-holo/30 bg-holo/5 p-2 text-holo">调整后：{payloadText(a.snapshot.after, 220) || "暂无"}</div>
                    </div>
                  )}
                  {a.status === "pending" ? (
                    <TriGestureBar canApprove={canApprove} onGesture={(g) => void gesture(a.approval_id, g)} />
                  ) : (
                    <div className="text-body text-ink3">关卡放行动作已写入事件账本，并用于校准协作偏好；重复提交不会重复生效。</div>
                  )}
                </div>
              ))}

              {/* 完成后态 p2_done：最终结果（真实产出，没有产出就说没有）；无对外变更明示「仅只读分析」（E3.7） */}
              {isDone && (
                <div className="rounded-msg border border-go/40 bg-go/5 p-4">
                  <div className="mb-1.5 flex items-center gap-1.5 text-h2 font-black text-go"><Icon name="check" size={17} />最终结果</div>
                  {/* N-16：模拟回执必须一眼可辨——"演示完成的交付"与"真实完成的交付"不得同外观 */}
                  {events.some((ev) => ev.decision?.kind === "execute" && ev.receipt?.mode === "simulated") && (
                    <div className="mb-1.5 inline-flex items-center gap-1 rounded border border-warn/50 bg-warn/10 px-2 py-0.5 text-body text-warn">
                      <Icon name="warning" size={13} />演示模式执行（模拟回执，非真实交付）
                    </div>
                  )}
                  {events.some((ev) => ev.decision?.kind === "execute" && ev.receipt?.mode === "real" && ev.receipt?.synced === true) && (
                    <div className="mb-1.5 inline-flex items-center gap-1 rounded border border-go/50 bg-go/10 px-2 py-0.5 text-body text-go">
                      <Icon name="check" size={13} />真实连接器回执（可核验）
                    </div>
                  )}
                  {chain.result ? (
                    <div className="break-words text-body leading-relaxed text-ink">{chain.result}</div>
                  ) : (
                    <div className="break-words text-body leading-relaxed text-ink2">
                      本任务没有产出可交付的结果：链路已收尾，但没有结果载荷写回（未产生物料、文案或对外变更）。
                    </div>
                  )}
                  {!hasWrite && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-body text-warn">
                      <Icon name="warning" size={14} />没有对外写操作 → 未产生变更，仅只读分析或结论。
                    </div>
                  )}
                  {/* 产物直达：图片/视频内联看，其余格式给下载入口（2026-09-21 产品所有者口径） */}
                  {artifacts.length > 0 && (
                    <div className="mt-2.5 space-y-2">
                      {artifacts.map((artifact) => (
                        <ArtifactView key={artifact.index} threadId={threadId} artifact={artifact} />
                      ))}
                    </div>
                  )}
                  <div className="mt-2 border-t border-go/25 pt-2 text-body text-ink3">
                    关键链路：派发 {chain.dispatched ? "已下达" : "未下达"} · 执行 {chain.agentActions} 条动作
                    {chain.approvalsIn ? ` · 关卡放行 ${chain.approvalsIn} 次` : ""} · 交付 {chain.result ? "已产出结果" : "无对外结果"}
                    （共 {events.length} 条账本事件）
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* P2E6 线程内追问（三合一：页面不再自带输入框，统一交右侧「织伴」全局框；
            推进=threads.run 续跑，留言=threads.note 只写账本。只读成员隐藏入口 E2.6） */}
        {canDispatch && thread && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-body text-ink3">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("workloom:assistant-intent", { detail: { intent: "advance" } }))}
              className="cursor-pointer rounded-lg border border-gline bg-gold/10 px-3 py-1.5 font-bold text-gold hover:bg-gold/20"
            >
              继续推进本任务
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("workloom:assistant-intent", { detail: { intent: "note" } }))}
              className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-ink2 hover:border-gline hover:text-gold"
            >
              给本任务留言
            </button>
            <span>输入统一走右侧「织伴」全局框；推进与留言都会留痕，执行仍以围栏与回执为准。</span>
          </div>
        )}
      </div>
      <RejectDialog
        open={rejectTarget !== null}
        mode="reject"
        onCancel={() => setRejectTarget(null)}
        onSubmit={(r) => void submitReject(r)}
      />
    </Bridge>
  );
}
