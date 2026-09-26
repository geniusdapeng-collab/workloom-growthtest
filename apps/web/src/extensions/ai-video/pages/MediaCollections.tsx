/**
 * 合集 / 重剪台（T-2026-0926-0008）· `/ai-video/media/collections`
 *
 * 数据源：`video.media.collections.*` + `video.media.recut` / `recutJob`
 * 关键交互：
 *  ① 左栏合集列表（用途/状态/段数）；② 右栏片单：拖拽或上/下移排序 → 保存顺序（reorder）；
 *  ③「开始重剪」→ 作业轮询（对齐交付返修作业范式）→ 完成后新成片自动出现在成片历史并标记"重剪"。
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { BannerAlert, EmptyState, Skeleton } from "../../../components/hud";
import { PageExitLink } from "../../../shell/PageExitLink";

interface CollectionSummary {
  id: string;
  title: string;
  purpose: string;
  status: string;
  itemCount: number;
  updatedAt: string;
  meta: Record<string, unknown>;
}

interface CollectionItem {
  asset_id: string;
  seq: number;
  kind: string;
  title: string | null;
  duration_seconds: string | null;
  local_path: string | null;
  status: string;
}

interface RecutJobView {
  jobId: string;
  status: "running" | "done" | "failed";
  segments: number;
  producedAssetId: string | null;
  error: string | null;
  log: string[];
  outputPath: string | null;
}

const PURPOSE_LABEL: Record<string, string> = { recut: "重剪", favorite: "收藏", campaign: "投放", archive: "存档" };

export default function MediaCollections() {
  const navigate = useNavigate();
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [job, setJob] = useState<RecutJobView | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const loadCollections = useCallback(async () => {
    await ensureDemoLogin();
    const result = await trpc.video.media.collections.list.query({ status: "all" });
    const list = result.items as CollectionSummary[];
    setCollections(list);
    setActiveId((prev) => prev ?? list[0]?.id ?? null);
  }, []);

  const loadDetail = useCallback(async (collectionId: string) => {
    const detail = await trpc.video.media.collections.get.query({ id: collectionId });
    setItems(detail.items as CollectionItem[]);
    setDirty(false);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        await loadCollections();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadCollections]);

  useEffect(() => {
    if (!activeId) return;
    (async () => {
      try {
        await loadDetail(activeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [activeId, loadDetail]);

  const createCollection = useCallback(async () => {
    const title = window.prompt("合集名称", `片单 ${new Date().toLocaleDateString("zh-CN")}`);
    if (!title) return;
    try {
      const created = await trpc.video.media.collections.create.mutate({ title, purpose: "recut" });
      await loadCollections();
      setActiveId(created.id);
      setNotice(`合集已创建：${created.title}（去媒资库勾选素材加入）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [loadCollections]);

  const move = useCallback((from: number, to: number) => {
    setItems((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next.map((item, index) => ({ ...item, seq: index + 1 }));
    });
    setDirty(true);
  }, []);

  const saveOrder = useCallback(async () => {
    if (!activeId) return;
    try {
      await trpc.video.media.collections.reorder.mutate({
        collectionId: activeId,
        orderedAssetIds: items.map((item) => item.asset_id),
      });
      setDirty(false);
      setNotice("片单顺序已保存（顺序即重剪镜头顺序）");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeId, items]);

  const removeItem = useCallback(async (assetId: string) => {
    if (!activeId) return;
    try {
      await trpc.video.media.collections.removeItem.mutate({ collectionId: activeId, assetId });
      await loadDetail(activeId);
      await loadCollections();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeId, loadDetail, loadCollections]);

  const startRecut = useCallback(async () => {
    if (!activeId) return;
    const active = collections.find((c) => c.id === activeId);
    try {
      if (dirty) await saveOrder();
      const started = await trpc.video.media.recut.mutate({ collectionId: activeId, title: active?.title ?? "重剪成片" });
      setNotice(`重剪作业已启动：${started.jobId}（${started.segments} 段）`);
      const timer = setInterval(async () => {
        try {
          const status = await trpc.video.media.recutJob.query({ jobId: started.jobId });
          setJob(status as RecutJobView);
          if (status.status !== "running") {
            clearInterval(timer);
            setNotice(status.status === "done" ? `重剪完成：新成片 ${status.producedAssetId}（见成片历史）` : `重剪失败：${status.error}`);
            await loadCollections();
            await loadDetail(activeId);
          }
        } catch (err) {
          clearInterval(timer);
          setError(err instanceof Error ? err.message : String(err));
        }
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeId, collections, dirty, saveOrder, loadCollections, loadDetail]);

  const active = collections.find((c) => c.id === activeId) ?? null;

  return (
    <div className="space-y-3 px-1 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <PageExitLink label="返回工作台" />
        <h2 className="text-h1 font-black text-ink">合集重剪台</h2>
        <span className="text-caption text-ink3">片单顺序 = 重剪镜头顺序；重剪是本地 ffmpeg 作业，不烧渲染额度</span>
        <div className="ml-auto flex gap-2">
          <button type="button" className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-caption text-ink2" onClick={() => void createCollection()}>
            新建合集
          </button>
          <button type="button" className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-caption text-ink2" onClick={() => navigate("/ai-video/media")}>
            去媒资库选素材 →
          </button>
        </div>
      </div>

      {notice ? <BannerAlert level="info" onAction={() => setNotice(null)} actionLabel="知道了">{notice}</BannerAlert> : null}
      {error ? <BannerAlert level="alert" onAction={() => setError(null)} actionLabel="关闭">{error}</BannerAlert> : null}
      {job && job.status === "running" ? <BannerAlert level="warn">{`重剪进行中：${job.log.at(-1) ?? "排队中"}`}</BannerAlert> : null}

      <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-xl border border-line bg-card p-3">
          <div className="text-body font-bold text-ink">合集</div>
          {loading ? <Skeleton count={3} variant="text" label="正在加载合集" /> : null}
          {!loading && collections.length === 0 ? <div className="mt-2 text-caption text-ink3">还没有合集。先新建一个，再去媒资库把镜头加入片单。</div> : null}
          <div className="mt-2 space-y-1">
            {collections.map((collection) => (
              <button
                key={collection.id}
                type="button"
                className={`w-full cursor-pointer rounded-lg border p-2 text-left ${collection.id === activeId ? "border-holo/60 bg-holo/5" : "border-line"}`}
                onClick={() => setActiveId(collection.id)}
              >
                <div className="text-caption font-bold text-ink">{collection.title}</div>
                <div className="text-[11px] text-ink3">
                  {PURPOSE_LABEL[collection.purpose] ?? collection.purpose} · {collection.itemCount} 段 · {collection.status === "used" ? "已产出" : "待用"}
                </div>
                {typeof collection.meta?.producedAssetId === "string" ? (
                  <div className="text-[11px] text-ink3">产出：{collection.meta.producedAssetId as string}</div>
                ) : null}
              </button>
            ))}
          </div>
        </aside>

        <section className="rounded-xl border border-line bg-card p-3">
          {!active ? (
            <EmptyState title="选择一个合集" description="左侧没有合集时先点「新建合集」，再到媒资库把镜头加入片单。" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-body font-bold text-ink">{active.title}</div>
                <span className="text-caption text-ink3">{items.length} 段 · 拖拽或点箭头调整顺序</span>
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-caption text-ink2"
                    onClick={() => void saveOrder()}
                    disabled={!dirty}
                  >
                    {dirty ? "保存顺序（未保存）" : "顺序已保存"}
                  </button>
                  <button
                    type="button"
                    className="wl-button wl-button--primary cursor-pointer rounded-lg bg-holo px-3 py-1.5 text-caption text-white"
                    onClick={() => void startRecut()}
                    disabled={items.length < 2}
                  >
                    开始重剪（{items.length} 段）
                  </button>
                </div>
              </div>

              {items.length === 0 ? (
                <div className="mt-3">
                  <EmptyState title="片单还是空的" description="去媒资库勾选「片单」把镜头加进来，至少 2 段才能重剪。" />
                </div>
              ) : (
                <ol className="mt-3 space-y-2">
                  {items.map((item, index) => (
                    <li
                      key={item.asset_id}
                      draggable
                      onDragStart={() => setDragIndex(index)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => {
                        if (dragIndex !== null && dragIndex !== index) move(dragIndex, index);
                        setDragIndex(null);
                      }}
                      className="flex items-center gap-2 rounded-lg border border-line p-2"
                    >
                      <span className="w-6 text-center text-caption text-ink3">{index + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-1 text-caption text-ink">{item.title ?? item.asset_id}</div>
                        <div className="text-[11px] text-ink3">
                          {item.kind}
                          {item.duration_seconds ? ` · ${Number(item.duration_seconds).toFixed(1)}s` : ""}
                          {item.local_path ? "" : " · 文件不在本机（重剪前需拉取）"}
                        </div>
                      </div>
                      <button type="button" className="cursor-pointer text-caption text-ink3" onClick={() => move(index, index - 1)} disabled={index === 0}>↑</button>
                      <button type="button" className="cursor-pointer text-caption text-ink3" onClick={() => move(index, index + 1)} disabled={index === items.length - 1}>↓</button>
                      <button type="button" className="cursor-pointer text-caption text-ink3" onClick={() => void removeItem(item.asset_id)}>移除</button>
                    </li>
                  ))}
                </ol>
              )}

              {job ? (
                <div className="mt-3 rounded-lg border border-line p-2">
                  <div className="text-caption text-ink2">作业 {job.jobId}：{job.status === "running" ? "执行中" : job.status === "done" ? "完成" : "失败"}</div>
                  <div className="mt-1 max-h-32 overflow-auto text-[11px] text-ink3">
                    {job.log.slice(-10).map((line, index) => <div key={index}>{line}</div>)}
                  </div>
                  {job.producedAssetId ? (
                    <button type="button" className="mt-1 cursor-pointer text-caption text-ink2" onClick={() => navigate("/ai-video/media/films")}>
                      看成片 →
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
