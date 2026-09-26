/**
 * 成片历史（T-2026-0926-0008）· `/ai-video/media/films`
 *
 * 数据源：`video.media.films`（kind='final_cut' 时间线 + 项目 + 发布任务状态）。
 * 关键交互：按项目筛选 / 播放 / 看提示词与来源（母版 or 变体、是否重剪产出）/ 回链生产页与制片档案。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { BannerAlert, EmptyState, Skeleton } from "../../../components/hud";
import { PageExitLink } from "../../../shell/PageExitLink";

interface FilmRow {
  id: string;
  title: string | null;
  projectId: string | null;
  projectTitle: string | null;
  pipelineKind: string | null;
  durationSeconds: number | null;
  createdAt: string;
  status: string;
  sourceType: string;
  url: string | null;
  thumbUrl: string | null;
  publishTasks: { total: number; published: number; failed: number };
}

const PIPELINE_LABEL: Record<string, string> = { narrative: "叙事片", marketing: "营销片", explainer: "口播解说片" };

export default function MediaFilms() {
  const navigate = useNavigate();
  const [items, setItems] = useState<FilmRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [selected, setSelected] = useState<FilmRow | null>(null);
  const [detail, setDetail] = useState<{ prompt: string | null; provenance: Record<string, unknown>; archive: { relative: string; exists: boolean } | null } | null>(null);

  const load = useCallback(async (mode: "reset" | "more") => {
    if (mode === "reset") setLoading(true);
    try {
      await ensureDemoLogin();
      const result = await trpc.video.media.films.query({
        cursor: mode === "more" ? cursor ?? undefined : undefined,
        limit: 40,
        projectId: projectFilter || undefined,
      });
      setItems((prev) => (mode === "reset" ? (result.items as FilmRow[]) : [...prev, ...(result.items as FilmRow[])]));
      setCursor(result.nextCursor);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cursor, projectFilter]);

  useEffect(() => { void load("reset"); }, [projectFilter]);
  useEffect(() => { const timer = setInterval(() => void load("reset"), 15_000); return () => clearInterval(timer); }, [load]);

  const projects = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) if (item.projectId) map.set(item.projectId, item.projectTitle ?? item.projectId);
    return [...map.entries()];
  }, [items]);

  const open = useCallback(async (film: FilmRow) => {
    setSelected(film);
    setDetail(null);
    try {
      const d = await trpc.video.media.get.query({ id: film.id });
      setDetail({
        prompt: (d as { prompt: string | null }).prompt,
        provenance: (d as { provenance: Record<string, unknown> }).provenance,
        archive: (d as { archive: { relative: string; exists: boolean } | null }).archive,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, FilmRow[]>();
    for (const item of items) {
      const key = item.projectTitle ?? item.projectId ?? "未关联项目";
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <div className="space-y-3 px-1 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <PageExitLink label="返回工作台" />
        <h2 className="text-h1 font-black text-ink">成片历史</h2>
        <span className="text-caption text-ink3">{items.length} 支成片（final_cut：交付母版/变体/重剪产出）</span>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="rounded-lg border border-line bg-card px-2 py-1.5 text-caption text-ink2"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
          >
            <option value="">全部项目</option>
            {projects.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
          </select>
          <button
            type="button"
            className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-caption text-ink2"
            onClick={() => navigate("/ai-video/media")}
          >
            去媒资库 →
          </button>
        </div>
      </div>

      {error ? <BannerAlert level="alert" onAction={() => setError(null)} actionLabel="关闭">{error}</BannerAlert> : null}
      {loading ? <Skeleton count={3} variant="card" label="正在加载成片历史" /> : null}
      {!loading && items.length === 0 ? (
        <EmptyState
          title="还没有成片入库"
          description="成片在交付包落盘（母版/变体）或本地重剪完成后自动入库；这里按项目与时间线汇总。"
        />
      ) : null}

      <div className="space-y-4">
        {grouped.map(([projectTitle, films]) => (
          <div key={projectTitle}>
            <div className="mb-2 text-caption font-bold text-ink2">{projectTitle}（{films.length}）</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {films.map((film) => (
                <button
                  key={film.id}
                  type="button"
                  className={`cursor-pointer overflow-hidden rounded-xl border bg-card text-left ${selected?.id === film.id ? "border-holo/60" : "border-line"}`}
                  onClick={() => void open(film)}
                >
                  <div className="relative aspect-video bg-black/30">
                    {film.thumbUrl
                      ? <img src={film.thumbUrl} alt={film.title ?? film.id} className="h-full w-full object-cover" loading="lazy" />
                      : <div className="flex h-full items-center justify-center text-caption text-ink3">成片</div>}
                    {film.durationSeconds !== null
                      ? <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{film.durationSeconds.toFixed(1)}s</span>
                      : null}
                  </div>
                  <div className="space-y-1 p-2">
                    <div className="line-clamp-1 text-caption font-bold text-ink">{film.title ?? film.id}</div>
                    <div className="flex flex-wrap gap-1 text-[10px] text-ink3">
                      {film.pipelineKind ? <span className="rounded bg-line/40 px-1.5 py-0.5">{PIPELINE_LABEL[film.pipelineKind]}</span> : null}
                      {film.sourceType === "recut" ? <span className="rounded bg-line/40 px-1.5 py-0.5">重剪</span> : null}
                      <span className="rounded bg-line/40 px-1.5 py-0.5">
                        发布 {film.publishTasks.published}/{film.publishTasks.total}
                        {film.publishTasks.failed > 0 ? `（失败 ${film.publishTasks.failed}）` : ""}
                      </span>
                    </div>
                    <div className="text-[10px] text-ink3">{new Date(film.createdAt).toLocaleString("zh-CN", { hour12: false })}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {cursor ? (
        <button
          type="button"
          className="w-full cursor-pointer rounded-lg border border-line py-2 text-caption text-ink2"
          onClick={() => void load("more")}
        >
          加载更多
        </button>
      ) : null}

      {selected ? (
        <div className="rounded-xl border border-line bg-card p-3">
          <div className="flex items-center justify-between">
            <div className="text-body font-bold text-ink">{selected.title ?? selected.id}</div>
            <button type="button" className="cursor-pointer text-caption text-ink3" onClick={() => setSelected(null)}>关闭</button>
          </div>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            {selected.url ? <video controls src={selected.url} className="w-full rounded-lg" /> : <div className="text-caption text-ink3">本机媒体仓没有该文件（云端素材可先点播触发按需拉取）。</div>}
            <div className="space-y-2 text-caption text-ink3">
              <div>素材 id：{selected.id}</div>
              {selected.projectId ? (
                <div>
                  项目：{selected.projectTitle ?? selected.projectId}
                  <button
                    type="button"
                    className="ml-2 cursor-pointer text-ink2"
                    onClick={() => navigate(`/ai-video/assets?tab=studio&project=${encodeURIComponent(selected.projectId!)}`)}
                  >
                    去生产页
                  </button>
                </div>
              ) : null}
              {detail?.archive ? <div className="break-all">制片档案：{detail.archive.relative}{detail.archive.exists ? "" : "（目录不存在）"}</div> : null}
              <div className="rounded border border-line p-2">
                <div className="text-[11px]">来源证据（provenance）</div>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(detail?.provenance ?? {}, null, 2)}</pre>
              </div>
              {detail?.prompt ? (
                <div className="rounded border border-line p-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span>提示词</span>
                    <button type="button" className="cursor-pointer text-ink2" onClick={() => void navigator.clipboard?.writeText(detail.prompt ?? "")}>复制</button>
                  </div>
                  <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">{detail.prompt}</div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
