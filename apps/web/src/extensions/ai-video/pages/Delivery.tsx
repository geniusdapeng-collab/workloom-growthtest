/**
 * 交付包（T-2026-0924-0071）· `/ai-video/assets?tab=delivery`
 *
 * 把"生成期一次出好几个风格版本"这件事变成用户能操作的界面：
 *   ① 左栏交付包列表（项目/时间/变体数/检查结论/已选版本/返修次数）；
 *   ② 右栏选中的包：干净母版 + 旁挂字幕文件 + 2–3 个风格变体（封面/文案/调色/BGM/转场对照）
 *      → 用户点「选这个版本」（选择记录 + 五元事件留痕）；
 *   ③ 返修区：写一句意见 → 「分析这条意见」走确定性分诊（归因 / 受影响层 / 是否需重生成镜头 / 成本）
 *      → 「执行本地重合成」（层增量重跑，不重新生成镜头；点名到画面内容时按钮禁用并要求 G8 人审）；
 *   ④ 重合成是作业：轮询进度与日志尾部，完成即出 v2 版本目录。
 *
 * 状态源：video.delivery.list / get / selectVariant / triage / startRevision / job
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { BannerAlert, EmptyState, Skeleton } from "../../../components/hud";

interface PackageSummary {
  dir: string;
  projectId: string;
  title: string;
  createdAt: string | null;
  platform: string | null;
  variantCount: number;
  variantIds: string[];
  passed: boolean;
  failedChecks: string[];
  selectedVariantId: string | null;
  revisionCount: number;
  coverRef: string | null;
}

interface VariantView {
  id: string;
  name: string;
  positioning: string | null;
  videoRef: string | null;
  videoPath: string | null;
  softsubRef: string | null;
  burnedRef: string | null;
  coverRef: string | null;
  coverText: string | null;
  duration: number | null;
  style: {
    color?: { profile?: string | null; lut?: string | null; intensity?: number | null } | null;
    bgm?: { mood?: string | null; style?: string | null; policy?: string | null; musicLevelDb?: number | null } | null;
    transitions?: { mode?: string; fadeSec?: number } | null;
    copyTone?: string | null;
  } | null;
  copy: { title: string | null; hashtags: string[]; checks: Array<{ kind: string; ok: boolean }> };
  audio: { trackId: string | null; trackTitle: string | null; lufs: number | null; autoTrimDb: number | null; failed: boolean; message: string | null } | null;
  isSelected: boolean;
}

interface PackageDetail extends PackageSummary {
  resolution: number[] | null;
  fps: number | null;
  master: { path: string | null; ref: string | null; duration: number | null; sha256: string | null; subtitles: string | null };
  subtitleFiles: Array<{ path: string; lang: string; format: string; ref: string | null; sha256: string | null }>;
  variants: VariantView[];
  divergence: Array<{ a: string; b: string; meanAbsDiff: number | null; verdict: string | null; audioDiffers: boolean }>;
  coverDivergence: Array<{ a: string; b: string; meanAbsDiff: number | null; verdict: string | null }>;
  checks: Array<{ kind: string; ok: boolean; detail: unknown }>;
  cost: { shotGeneration?: string; tokenCostDelta?: number | string; note?: string } | null;
  revisions: Array<{ version: number | null; at: string | null; localOnly: boolean | null; outDir: string | null }>;
  latestRevisionWarnings: string[];
}

interface TriageView {
  kinds: string[];
  attributions: string[];
  layers: string[];
  requiresShotRegeneration: boolean;
  shotIds: string[];
  gate: string | null;
  costHint: { tokenCostDelta: number | string; note: string };
  reply: string;
  nextActions: string[];
  patchHint: Record<string, unknown>;
}

interface RevisionJobView {
  jobId: string;
  dir: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  logTail: string[];
  version: number | null;
  outDir: string | null;
}

const CHECK_LABEL: Record<string, string> = {
  master_no_burn_in: "母版不烧字幕",
  sidecar_files: "旁挂字幕文件",
  variant_count: "变体数量",
  variants_distinct: "变体差异可辨",
  covers_distinct: "封面差异可辨",
  bgm_layer: "配乐层复检",
  softsub_video_unchanged: "软字幕轨画面零改动",
  duration_consistent: "时长一致",
};

const LAYER_LABEL: Record<string, string> = {
  shots: "镜头产物",
  assemble: "拼接/转场",
  color: "调色",
  audio: "配乐",
  text: "字幕",
  cover: "封面",
  copy: "文案",
};

const VERDICT_CLS: Record<string, string> = {
  visible: "border-go/45 text-go",
  subtle: "border-warn/50 text-warn",
  negligible: "border-alert/55 text-alert",
};

function fmtTime(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return value;
  }
}

export default function Delivery() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const preferDir = params.get("package");
  const [ready, setReady] = useState(false);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [activeDir, setActiveDir] = useState<string | null>(null);
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [triage, setTriage] = useState<TriageView | null>(null);
  const [job, setJob] = useState<RevisionJobView | null>(null);
  /** 返修表单：字幕与配乐是两条最常用的轴，给输入框；其余轴走高级 JSON。 */
  const [subtitleText, setSubtitleText] = useState("");
  const [bgmInput, setBgmInput] = useState("");
  const [advancedPatch, setAdvancedPatch] = useState("{}");
  const pollRef = useRef<number | null>(null);

  const loadList = useCallback(async (silent = false) => {
    if (!silent) setReady(false);
    try {
      await ensureDemoLogin();
      const rows = await trpc.video.delivery.list.query({ limit: 20 }) as unknown as PackageSummary[];
      setPackages(rows);
      setActiveDir((cur) => cur ?? preferDir ?? rows[0]?.dir ?? null);
    } catch (e) {
      setBanner({ level: "alert", text: `交付包列表加载失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setReady(true);
    }
  }, [preferDir]);

  const loadDetail = useCallback(async (dir: string) => {
    try {
      const row = await trpc.video.delivery.get.query({ dir }) as unknown as PackageDetail;
      setDetail(row);
    } catch (e) {
      setDetail(null);
      setBanner({ level: "alert", text: `交付包加载失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    if (!activeDir) return;
    setTriage(null);
    setSubtitleText("");
    setBgmInput("");
    setAdvancedPatch("{}");
    setJob(null);
    void loadDetail(activeDir);
  }, [activeDir, loadDetail]);

  // 作业进度轮询（1.5s）：重合成是本地 ffmpeg，秒级到分钟级，轮询比长连接简单可靠
  useEffect(() => {
    if (!job || job.status !== "running") return;
    pollRef.current = window.setInterval(async () => {
      try {
        const next = await trpc.video.delivery.job.query({ jobId: job.jobId }) as unknown as RevisionJobView | null;
        if (!next) return;
        setJob(next);
        if (next.status !== "running") {
          window.clearInterval(pollRef.current ?? undefined);
          pollRef.current = null;
          if (activeDir) await loadDetail(activeDir);
          await loadList(true);
        }
      } catch {
        /* 轮询失败不打扰用户：下一拍继续 */
      }
    }, 1500);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [job, activeDir, loadDetail, loadList]);

  const selectVariant = useCallback(async (variantId: string, variantName: string) => {
    if (!activeDir) return;
    setBusy(`select:${variantId}`);
    setBanner(null);
    try {
      await trpc.video.delivery.selectVariant.mutate({ dir: activeDir, variantId });
      setBanner({ level: "info", text: `已选定「${variantName}」：选择记录与事件账本都已留痕，后期合成/发布按这个版本走。` });
      await loadDetail(activeDir);
      await loadList(true);
    } catch (e) {
      setBanner({ level: "alert", text: `选择失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [activeDir, loadDetail, loadList]);

  const analyzeFeedback = useCallback(async () => {
    if (!activeDir || !feedback.trim()) return;
    setBusy("triage");
    setBanner(null);
    try {
      const outcome = await trpc.video.delivery.triage.mutate({
        dir: activeDir, feedback: feedback.trim(), record: true,
      }) as unknown as { triage: TriageView };
      setTriage(outcome.triage);
      setBanner({ level: "info", text: "分诊完成：返修单已落盘（revision-requests/），下面是可以执行的 patch 预览。" });
    } catch (e) {
      setBanner({ level: "alert", text: `分诊失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [activeDir, feedback]);

  /**
   * 组 patch：表单里的真实内容优先，高级 JSON 作为兜底/扩展。
   * **不给"直接跑模板"的入口**——分诊的 patchHint 是提示（含 `<...>` 占位符），
   * 服务端也会拦占位符与空 patch（系统不替用户猜要改成什么）。
   */
  const composedPatch = useMemo<{ patch: Record<string, unknown>; error: string | null }>(() => {
    let advanced: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(advancedPatch || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { patch: {}, error: "高级 patch 必须是对象（JSON object）" };
      }
      advanced = parsed as Record<string, unknown>;
    } catch (e) {
      return { patch: {}, error: `高级 patch 不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
    }
    const patch: Record<string, unknown> = { ...advanced };
    if (subtitleText.trim()) patch.subtitles = { ...(patch.subtitles as Record<string, unknown> | undefined), zhText: subtitleText };
    if (bgmInput.trim()) {
      const value = bgmInput.trim();
      /**
       * 曲目输入两种口径（默认按**风格/情绪关键词**走检索，而不是当曲目 id）：
       *   · `id:<曲目id>` → 精确指定（工位会做许可校验，找不到就报错）；
       *   · 其他一律当风格/情绪关键词（corporate-clean / 温暖自在 / 运动 高燃 都能命中——
       *     工位在**全量曲库**的 id/style/styleLabel/genre/mood/tags 上匹配）。
       * 早先把 `corporate-clean` 当曲目 id 处理，结果三变体全被判 not_found（如实降级但不达意）。
       */
      patch.bgm = {
        ...(patch.bgm as Record<string, unknown> | undefined),
        ...(value.toLowerCase().startsWith("id:") ? { trackId: value.slice(3).trim() } : { style: value }),
      };
    }
    return { patch, error: null };
  }, [advancedPatch, subtitleText, bgmInput]);

  const runRevision = useCallback(async () => {
    if (!activeDir) return;
    if (composedPatch.error) {
      setBanner({ level: "alert", text: composedPatch.error });
      return;
    }
    if (Object.keys(composedPatch.patch).length === 0) {
      setBanner({ level: "warn", text: "先填一处具体修改（字幕文本 / 曲目 / 高级 patch），再执行——分诊提示本身是模板，不能直接跑。" });
      return;
    }
    const patch = composedPatch.patch;
    setBusy("revise");
    setBanner(null);
    try {
      const created = await trpc.video.delivery.startRevision.mutate({ dir: activeDir, patch }) as unknown as RevisionJobView;
      setJob(created);
      setBanner({ level: "info", text: `本地重合成已启动（作业 ${created.jobId}）：只重算受影响的层，镜头不重新生成。` });
    } catch (e) {
      setBanner({ level: "alert", text: `重合成启动失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [activeDir, composedPatch]);

  const active = useMemo(
    () => packages.find((row) => row.dir === activeDir) ?? null,
    [packages, activeDir],
  );

  /**
   * 交付物取件（封面上屏 / 字幕下载 / 成片预览）。
   * 走 `video.delivery.artifact`（路径监狱 + 8MB 页内上限）：拿得到的转成 data URL，
   * 超上限的记成错误文案 → 界面提示"用本地播放器打开 <包内路径>"，不硬搬大文件。
   */
  const [artifacts, setArtifacts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!detail || !activeDir) return;
    const refs = [
      detail.master.ref,
      ...detail.subtitleFiles.map((file) => file.ref),
      ...detail.variants.flatMap((variant) => [variant.coverRef, variant.videoRef, variant.softsubRef]),
    ].filter((ref): ref is string => Boolean(ref));
    const unique = [...new Set(refs)];
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const ref of unique) {
        try {
          const payload = await trpc.video.delivery.artifact.query({ dir: activeDir, ref }) as unknown as {
            base64: string; contentType: string;
          };
          next[ref] = `data:${payload.contentType};base64,${payload.base64}`;
        } catch (error) {
          next[ref] = `error:${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (!cancelled) setArtifacts((current) => ({ ...current, ...next }));
    })();
    return () => { cancelled = true; };
  }, [detail, activeDir]);

  const artifactUrl = useCallback((ref: string | null | undefined): string | null => {
    if (!ref) return null;
    const value = artifacts[ref];
    return value && !value.startsWith("error:") ? value : null;
  }, [artifacts]);
  const artifactError = useCallback((ref: string | null | undefined): string | null => {
    if (!ref) return null;
    const value = artifacts[ref];
    return value?.startsWith("error:") ? value.slice(6) : null;
  }, [artifacts]);

  if (!ready) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {/* 页面级出口：交付包是二级页，除了外壳的统一出口，页内再给一条明确的返回路径（回归测试 PageExitAffordance 要求） */}
      <button
        type="button"
        className="text-xs text-ink3 hover:text-holo"
        onClick={() => nav("/ai-video/assets")}
      >
        ← 返回片库 / 脚本 CMS
      </button>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-orb text-xl text-ink">交付包 · 多风格版本与返修</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink3">
            一支片子出 2–3 个风格明显不同的版本（封面 / 文案 / 配乐 / 调色 / 转场），你挑一个；
            字幕以旁挂文件交付（母版不烧字，要带字幕走可开关字幕轨）。有意见直接写一句，先在本地重合成，
            只有点名到画面内容才需要重生成镜头（走人审）。
          </p>
        </div>
        <button
          type="button"
          className="rounded border border-line px-3 py-1 text-sm text-ink2 hover:border-holo/60 hover:text-holo"
          onClick={() => void loadList()}
        >
          刷新
        </button>
      </header>

      {banner ? <BannerAlert level={banner.level} >{banner.text}</BannerAlert> : null}

      {detail && detail.latestRevisionWarnings.length > 0 ? (
        <div className="rounded border border-warn/50 bg-warn/5 p-3 text-xs text-warn">
          <div className="font-orb">上一轮返修有未达标项（已如实记账，没有静默降级）</div>
          <ul className="mt-1 list-disc pl-5">
            {detail.latestRevisionWarnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <aside className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-ink4">交付包（{packages.length}）</div>
          {packages.length === 0 ? (
            <div className="rounded border border-line/60 p-3 text-sm text-ink3">
              还没有交付包。出片工具会把它写到交付根（默认 <code>var/delivery</code>，
              可用 <code>WORKLOOM_DELIVERY_DIR</code> 指定）：
              <pre className="mt-2 overflow-x-auto rounded bg-black/30 p-2 text-xs">
{`post-cli deliver --project project.json \\
  --shots a.mp4,b.mp4 --srt subs.srt --out-dir var/delivery/<项目>-<时间>`}
              </pre>
            </div>
          ) : packages.map((row) => (
            <button
              key={row.dir}
              type="button"
              onClick={() => setActiveDir(row.dir)}
              className={`w-full rounded border p-3 text-left transition ${row.dir === activeDir ? "border-holo/60 bg-holo/5" : "border-line/60 hover:border-line"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-orb text-sm text-ink">{row.title}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[11px] ${row.passed ? "border-go/45 text-go" : "border-alert/55 text-alert"}`}>
                  {row.passed ? "检查全绿" : `${row.failedChecks.length} 项待看`}
                </span>
              </div>
              <div className="mt-1 text-xs text-ink3">
                {row.platform ?? "默认平台"} · {row.variantCount} 个版本 · {row.revisionCount} 次返修
              </div>
              <div className="mt-1 text-[11px] text-ink4">{fmtTime(row.createdAt)}</div>
              {row.selectedVariantId ? (
                <div className="mt-1 text-[11px] text-go">已选：{row.selectedVariantId}</div>
              ) : null}
            </button>
          ))}
        </aside>

        <section className="space-y-4">
          {!detail ? (
            <EmptyState icon="🎬" title="先选一个交付包" hint="左栏选包后，这里会显示母版、旁挂字幕、几个风格版本与差异实测。" />
          ) : (
            <>
              <div className="rounded border border-line/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-orb text-sm text-ink">
                    干净母版（不含字幕）
                    <span className="ml-2 text-xs text-ink3">
                      {detail.resolution ? `${detail.resolution[0]}×${detail.resolution[1]}` : ""} {detail.fps ? `@${detail.fps}fps` : ""}
                      {detail.master.duration ? ` · ${detail.master.duration}s` : ""}
                    </span>
                  </div>
                  {artifactUrl(detail.master.ref) ? (
                    <a className="text-xs text-holo underline" href={artifactUrl(detail.master.ref)!} download={`${active?.dir ?? "master"}-master.mp4`}>下载母版</a>
                  ) : null}
                </div>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {artifactUrl(detail.master.ref) ? (
                    <video className="w-full rounded border border-line/50" src={artifactUrl(detail.master.ref)!} controls preload="metadata" />
                  ) : (
                    <div className="text-xs text-ink3">
                      {artifactError(detail.master.ref) ?? "母版文件缺失"}
                      {detail.master.path ? <div className="mt-1 text-ink4">本地路径：{detail.master.path}</div> : null}
                    </div>
                  )}
                  <div className="space-y-1 text-xs text-ink3">
                    <div>旁挂字幕（母版未烧字，可后置决定用不用）：</div>
                    {detail.subtitleFiles.length === 0 ? <div>本次未提供字幕</div> : detail.subtitleFiles.map((file) => (
                      <div key={file.path} className="flex items-center gap-2">
                        <span className="rounded bg-black/30 px-1.5 py-0.5">{file.format.toUpperCase()}</span>
                        <span>{file.lang}</span>
                        {artifactUrl(file.ref) ? (
                          <a className="text-holo underline" href={artifactUrl(file.ref)!} download={file.path.split("/").pop() ?? "subtitle"}>下载</a>
                        ) : null}
                      </div>
                    ))}
                    {detail.cost ? <div className="pt-2 text-[11px] text-ink4">{detail.cost.note ?? ""}</div> : null}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs uppercase tracking-wide text-ink4">风格版本（挑一个）</div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {detail.variants.map((variant) => (
                    <article
                      key={variant.id}
                      className={`flex flex-col rounded border p-3 ${variant.isSelected ? "border-go/60 bg-go/5" : "border-line/60"}`}
                    >
                      {artifactUrl(variant.coverRef) ? (
                        <img className="mb-2 w-full rounded border border-line/40 object-cover" src={artifactUrl(variant.coverRef)!} alt={`${variant.name} 封面`} />
                      ) : (
                        <div className="mb-2 grid h-40 place-items-center rounded border border-dashed border-line/50 text-xs text-ink4">无封面</div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-orb text-sm text-ink">{variant.name}</h3>
                        {variant.isSelected ? <span className="rounded border border-go/50 px-1.5 py-0.5 text-[11px] text-go">已选</span> : null}
                      </div>
                      {variant.positioning ? <p className="mt-1 text-xs text-ink3">{variant.positioning}</p> : null}
                      <ul className="mt-2 space-y-1 text-[11px] text-ink3">
                        <li>调色：{variant.style?.color
                          ? `${variant.style.color.profile ?? variant.style.color.lut ?? "有色"} @${variant.style.color.intensity ?? "-"}`
                          : "不调色"}</li>
                        <li>配乐：{variant.audio
                          ? `${variant.audio.trackTitle ?? variant.audio.trackId ?? "已配乐"}${variant.audio.lufs ? ` · ${variant.audio.lufs} LUFS` : ""}`
                          : "原声"}</li>
                        <li>转场：{variant.style?.transitions
                          ? `${variant.style.transitions.mode ?? "-"}${variant.style.transitions.fadeSec ? ` ${variant.style.transitions.fadeSec}s` : ""}`
                          : "默认"}</li>
                        <li>文案口吻：{variant.style?.copyTone ?? "默认"}</li>
                      </ul>
                      {variant.copy.title ? (
                        <div className="mt-2 rounded bg-black/25 p-2 text-[11px] text-ink2">
                          <div>标题：{variant.copy.title}</div>
                          {variant.copy.hashtags.length ? <div className="mt-1 text-ink3">{variant.copy.hashtags.join(" ")}</div> : null}
                        </div>
                      ) : null}
                      {variant.audio?.autoTrimDb && variant.audio.autoTrimDb < 0 ? (
                        <div className="mt-2 rounded border border-warn/40 p-2 text-[11px] text-warn">
                          配乐首档压住人声，已自动降 {variant.audio.autoTrimDb}dB 后通过（如实记账）
                        </div>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          data-testid={`delivery-select-${variant.id}`}
                          disabled={busy === `select:${variant.id}`}
                          onClick={() => void selectVariant(variant.id, variant.name)}
                          className={`rounded border px-2 py-1 text-xs ${variant.isSelected ? "border-go/60 text-go" : "border-holo/50 text-holo hover:bg-holo/10"}`}
                        >
                          {busy === `select:${variant.id}` ? "提交中…" : variant.isSelected ? "已选这个版本" : "选这个版本"}
                        </button>
                        {artifactUrl(variant.videoRef) ? (
                          <a className="text-xs text-ink2 underline" href={artifactUrl(variant.videoRef)!} download={`${variant.id}.mp4`}>下载成片</a>
                        ) : null}
                        {artifactUrl(variant.softsubRef) ? (
                          <a className="text-xs text-ink2 underline" href={artifactUrl(variant.softsubRef)!} download={`${variant.id}-softsub.mp4`}>软字幕轨版</a>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded border border-line/60 p-3">
                  <div className="text-xs uppercase tracking-wide text-ink4">版本差异（实测，不是声明）</div>
                  <table className="mt-2 w-full text-xs text-ink3">
                    <thead>
                      <tr className="text-left text-ink4">
                        <th className="py-1">对比</th>
                        <th className="py-1">画面平均像素差</th>
                        <th className="py-1">判定</th>
                        <th className="py-1">音轨</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.divergence.map((row) => (
                        <tr key={`${row.a}-${row.b}`} className="border-t border-line/30">
                          <td className="py-1">{row.a} × {row.b}</td>
                          <td className="py-1">{row.meanAbsDiff ?? "—"}/255</td>
                          <td className="py-1">
                            <span className={`rounded border px-1.5 py-0.5 text-[11px] ${VERDICT_CLS[row.verdict ?? ""] ?? "border-line text-ink3"}`}>
                              {row.verdict ?? "—"}
                            </span>
                          </td>
                          <td className="py-1">{row.audioDiffers ? "不同" : "相同"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rounded border border-line/60 p-3">
                  <div className="text-xs uppercase tracking-wide text-ink4">交付检查</div>
                  <ul className="mt-2 space-y-1 text-xs">
                    {detail.checks.map((check) => (
                      <li key={check.kind} className="flex items-center justify-between gap-2">
                        <span className="text-ink2">{CHECK_LABEL[check.kind] ?? check.kind}</span>
                        <span className={check.ok ? "text-go" : "text-alert"}>{check.ok ? "通过" : "未通过"}</span>
                      </li>
                    ))}
                  </ul>
                  {detail.revisions.length > 0 ? (
                    <div className="mt-3 text-xs text-ink3">
                      <div className="text-ink4">返修历史</div>
                      {detail.revisions.map((rev) => (
                        <div key={`${rev.version}-${rev.at}`} className="mt-1">
                          v{rev.version ?? "?"} · {fmtTime(rev.at)} · {rev.localOnly === false ? "含镜头重生成" : "本地重合成"}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="rounded border border-line/60 p-3">
                <div className="text-xs uppercase tracking-wide text-ink4">提返修意见（先在本地重合成，不重新生成镜头）</div>
                <textarea
                  data-testid="delivery-feedback"
                  className="mt-2 h-20 w-full rounded border border-line/60 bg-black/20 p-2 text-sm text-ink outline-none focus:border-holo/60"
                  placeholder="例：配乐太吵了，另外第 3 个镜头的封面字太小 / 字幕时间轴晚了半秒"
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="delivery-analyze"
                    disabled={!feedback.trim() || busy === "triage"}
                    onClick={() => void analyzeFeedback()}
                    className="rounded border border-holo/50 px-3 py-1 text-sm text-holo hover:bg-holo/10 disabled:opacity-40"
                  >
                    {busy === "triage" ? "分析中…" : "分析这条意见"}
                  </button>
                  {triage ? (
                    <button
                      type="button"
                      data-testid="delivery-run-revision"
                      disabled={triage.requiresShotRegeneration || busy === "revise" || Object.keys(composedPatch.patch).length === 0}
                      onClick={() => void runRevision()}
                      className="rounded border border-go/50 px-3 py-1 text-sm text-go hover:bg-go/10 disabled:opacity-40"
                    >
                      {busy === "revise" ? "启动中…" : "执行本地重合成（按下面填的内容）"}
                    </button>
                  ) : null}
                </div>

                {triage ? (
                  <div className="mt-3 space-y-2 text-xs">
                    <div className="flex flex-wrap gap-2">
                      {triage.attributions.map((code) => (
                        <span key={code} className="rounded border border-line/60 px-1.5 py-0.5 text-ink3">{code}</span>
                      ))}
                    </div>
                    <div className="text-ink2">
                      受影响层：{triage.layers.length ? triage.layers.map((layer) => LAYER_LABEL[layer] ?? layer).join(" → ") : "需要人工指认"}
                    </div>
                    <div className={triage.requiresShotRegeneration ? "text-warn" : "text-go"}>
                      {triage.requiresShotRegeneration
                        ? `点名到画面内容（${triage.shotIds.join("、") || "未点名"}）：需要先过 ${triage.gate ?? "G8"} 人审并重生成点名镜头，本页不烧渲染额度`
                        : "后期能解决：本地重合成即可，镜头不重新生成"}
                    </div>
                    <div className="text-ink3">成本：{triage.costHint.note}</div>
                    <div className="text-ink3">回给用户：{triage.reply}</div>
                    {!triage.requiresShotRegeneration ? (
                      <div className="space-y-2 rounded border border-line/40 p-2">
                        <div className="text-ink4">要改成什么（填了才可执行）</div>
                        {triage.layers.includes("text") ? (
                          <label className="block">
                            <span className="text-ink3">新字幕（SRT 全文；留空则不改字幕）</span>
                            <textarea
                              data-testid="delivery-revision-subtitles"
                              className="mt-1 h-24 w-full rounded border border-line/60 bg-black/20 p-2 font-mono text-[11px] text-ink2"
                              placeholder={"1\n00:00:00,300 --> 00:00:02,500\n改好的字幕文案"}
                              value={subtitleText}
                              onChange={(event) => setSubtitleText(event.target.value)}
                            />
                          </label>
                        ) : null}
                        {triage.layers.includes("audio") ? (
                          <label className="block">
                            <span className="text-ink3">配乐：风格 / 情绪关键词（例：corporate-clean、温暖自在、运动 高燃）；精确指定曲目写 id:&lt;曲目id&gt;</span>
                            <input
                              data-testid="delivery-revision-bgm"
                              className="mt-1 w-full rounded border border-line/60 bg-black/20 p-2 text-xs text-ink2"
                              value={bgmInput}
                              onChange={(event) => setBgmInput(event.target.value)}
                            />
                          </label>
                        ) : null}
                        <details>
                          <summary className="cursor-pointer text-ink4">高级：直接写 patch JSON（调色/封面/文案/转场等）</summary>
                          <textarea
                            data-testid="delivery-revision-advanced"
                            className="mt-1 h-28 w-full rounded border border-line/60 bg-black/30 p-2 font-mono text-[11px] text-ink2"
                            value={advancedPatch}
                            onChange={(event) => setAdvancedPatch(event.target.value)}
                          />
                          <div className="mt-1 text-[11px] text-ink4">
                            分诊模板（**是提示不是可执行内容**，占位符要换成真实值）：
                            <pre className="mt-1 overflow-x-auto rounded bg-black/30 p-2">{JSON.stringify(triage.patchHint, null, 2)}</pre>
                          </div>
                        </details>
                        <div className="text-[11px] text-ink4">
                          将要提交的 patch：<code>{JSON.stringify(composedPatch.patch)}</code>
                          {composedPatch.error ? <span className="text-alert"> · {composedPatch.error}</span> : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {job ? (
                  <div className="mt-3 rounded border border-line/50 p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-ink2">
                        作业 {job.jobId} · {job.status === "running" ? "执行中" : job.status === "done" ? "已完成" : "失败"}
                        {job.version ? ` · v${job.version}` : ""}
                      </span>
                      <span className="text-ink4">{job.finishedAt ? fmtTime(job.finishedAt) : fmtTime(job.startedAt)}</span>
                    </div>
                    <pre className="mt-2 max-h-40 overflow-auto rounded bg-black/30 p-2 text-[11px] text-ink3">
{job.logTail.slice(-12).join("\n")}
                    </pre>
                    {job.status === "done" && job.outDir ? (
                      <div className="mt-1 text-go">新版本目录：{job.outDir}（刷新列表可见 v{job.version} 的返修记录）</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
