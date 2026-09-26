/**
 * 媒资库（T-2026-0926-0008）· `/ai-video/media`
 *
 * ① 筛选条：类型多选 / 管线 / 来源 / 全文搜索（标题+提示词，后端三层检索 tsv→trgm→语义）；
 * ② 素材网格：缩略图卡片（时长角标 + kind chip + 管线 chip），游标加载更多；
 * ③ 右栏详情：签名 URL 预览 / 提示词全文（一键复制）/ 标签编辑 / 版本链 /
 *    来源回链（项目 · 制片档案目录）/ 选入合集 / 归档；
 * ④ 底部抽屉：本次挑选的片单 → 加入合集 →「开始重剪」→ 作业轮询；
 * ⑤ 上传：选文件 → uploadTicket → POST /media/upload（XHR 进度）→ registerUpload（sha256 复核）。
 *
 * 状态源：video.media.list / get / updateMeta / archive / tagGroups / quota /
 *         collections.* / uploadTicket / registerUpload / recut / recutJob
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { BannerAlert, EmptyState, Skeleton } from "../../../components/hud";
import { PageExitLink } from "../../../shell/PageExitLink";

const KIND_LABEL: Record<string, string> = {
  clip: "镜头", final_cut: "成片", portrait: "定妆照", cover: "封面",
  shot_plate: "底板", upload_video: "上传视频", upload_image: "上传图",
  upload_audio: "上传音频", product_image: "商品图", reference_image: "参考图",
};
const KIND_ORDER = Object.keys(KIND_LABEL);
const PIPELINE_LABEL: Record<string, string> = { narrative: "叙事片", marketing: "营销片", explainer: "口播解说片" };
const SOURCE_LABEL: Record<string, string> = {
  generated: "生产生成", uploaded: "用户上传", imported: "外部导入", recut: "重剪产出",
};
const UPLOAD_KINDS = [
  { value: "upload_video", label: "视频" },
  { value: "upload_image", label: "图片" },
  { value: "upload_audio", label: "音频" },
] as const;

interface MediaItem {
  id: string;
  kind: string;
  title: string | null;
  tags: string[];
  prompt: string | null;
  pipelineKind: string | null;
  sourceType: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  status: string;
  syncState: string;
  projectId: string | null;
  version: number;
  chainId: string;
  createdAt: string;
  bytes: number | null;
  localPath: string | null;
  hasLocalFile: boolean;
  url: string | null;
  thumbUrl: string | null;
  similarity: number | null;
}

interface MediaDetail extends MediaItem {
  provenance: Record<string, unknown>;
  meta: Record<string, unknown>;
  licenseRisk: string;
  versions: Array<{ id: string; version: number; status: string; createdAt: string; sha256: string }>;
  project: { id: string; title: string; kind: string; status: string } | null;
  archive: { relative: string; exists: boolean } | null;
}

const fmtBytes = (n: number | null) => {
  if (!n) return "—";
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
};
const fmtDuration = (s: number | null) => (s === null ? null : `${s.toFixed(1)}s`);
const fmtTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

export default function MediaLibrary() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<{ kinds: string[]; pipeline: string; source: string; query: string; tag: string }>({
    kinds: [], pipeline: "", source: "", query: "", tag: "",
  });
  const [items, setItems] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searchTrace, setSearchTrace] = useState<{ layer: string; mock: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<MediaDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [tagGroups, setTagGroups] = useState<Array<{ group: string; tags: Array<{ name: string; usage: number }> }>>([]);
  const [tray, setTray] = useState<string[]>([]);
  const [collections, setCollections] = useState<Array<{ id: string; title: string; status: string; itemCount: number }>>([]);
  const [quota, setQuota] = useState<{ usedBytes: number; quotaBytes: number } | null>(null);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [uploadKind, setUploadKind] = useState<string>("upload_video");
  const [job, setJob] = useState<{ jobId: string; status: string; log: string[]; producedAssetId: string | null; error: string | null } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (mode: "reset" | "more") => {
    if (mode === "reset") setLoading(true); else setLoadingMore(true);
    try {
      await ensureDemoLogin();
      const result = await trpc.video.media.list.query({
        kind: filters.kinds.length ? (filters.kinds as never) : undefined,
        pipelineKind: filters.pipeline ? (filters.pipeline as never) : undefined,
        sourceType: filters.source ? (filters.source as never) : undefined,
        tags: filters.tag ? [filters.tag] : undefined,
        query: filters.query.trim() || undefined,
        cursor: mode === "more" ? cursor ?? undefined : undefined,
        limit: 60,
      });
      setItems((prev) => (mode === "reset" ? (result.items as MediaItem[]) : [...prev, ...(result.items as MediaItem[])]));
      setCursor(result.nextCursor);
      setSearchTrace(result.searchTrace ? { layer: result.searchTrace.layer, mock: result.searchTrace.mock } : null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [filters, cursor]);

  useEffect(() => { void load("reset"); }, [filters.kinds.join(","), filters.pipeline, filters.source, filters.tag, filters.query]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!uploading) void load("reset");
    }, 15_000);
    return () => clearInterval(timer);
  }, [load, uploading]);

  const loadSide = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [groups, cols, q] = await Promise.all([
        trpc.video.media.tagGroups.query(),
        trpc.video.media.collections.list.query({ status: "all" }),
        trpc.video.media.quota.query(),
      ]);
      setTagGroups(groups.groups as never);
      setCollections(cols.items as never);
      setQuota(q as never);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => { void loadSide(); }, [loadSide]);

  const openDetail = useCallback(async (id: string) => {
    setDetailBusy(true);
    try {
      await ensureDemoLogin();
      const detail = await trpc.video.media.get.query({ id });
      setSelected(detail as MediaDetail);
      setTagDraft((detail.tags ?? []).join("、"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailBusy(false);
    }
  }, []);

  const saveTags = useCallback(async () => {
    if (!selected) return;
    const tags = tagDraft.split(/[、,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
    try {
      await trpc.video.media.updateMeta.mutate({ id: selected.id, tags });
      setSelected({ ...selected, tags });
      setNotice(`标签已保存（${tags.length} 个）`);
      void loadSide();
      void load("reset");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selected, tagDraft, load, loadSide]);

  const archiveSelected = useCallback(async () => {
    if (!selected) return;
    try {
      await trpc.video.media.archive.mutate({ id: selected.id });
      setNotice(`素材已归档：${selected.title ?? selected.id}`);
      setSelected(null);
      void load("reset");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selected, load]);

  const toggleTray = useCallback((id: string) => {
    setTray((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const makeCollectionAndRecut = useCallback(async () => {
    if (tray.length < 2) { setError("至少选 2 段素材才能重剪"); return; }
    try {
      const title = window.prompt("合集/成片名称", `重剪 ${new Date().toLocaleString("zh-CN", { hour12: false })}`);
      if (!title) return;
      const collection = await trpc.video.media.collections.create.mutate({ title, purpose: "recut" });
      for (const assetId of tray) {
        await trpc.video.media.collections.addItem.mutate({ collectionId: collection.id, assetId });
      }
      const started = await trpc.video.media.recut.mutate({ collectionId: collection.id, title });
      setNotice(`重剪作业已启动（${started.segments} 段）：${started.jobId}`);
      setTray([]);
      const poll = setInterval(async () => {
        try {
          const status = await trpc.video.media.recutJob.query({ jobId: started.jobId });
          setJob(status as never);
          if (status.status !== "running") {
            clearInterval(poll);
            setNotice(status.status === "done" ? `重剪完成：新成片 ${status.producedAssetId}` : `重剪失败：${status.error}`);
            void load("reset");
            void loadSide();
          }
        } catch (err) {
          clearInterval(poll);
          setError(err instanceof Error ? err.message : String(err));
        }
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tray, load, loadSide]);

  const upload = useCallback(async (file: File) => {
    setUploading({ name: file.name, percent: 0 });
    try {
      await ensureDemoLogin();
      const ticket = await trpc.video.media.uploadTicket.mutate({ filename: file.name, bytes: file.size, kind: uploadKind as never });
      /** 上传结果由服务端给出 sha256 与 relPath（前端不自拼路径，登记时服务端还会复核归属与指纹） */
      const uploaded = await new Promise<{ sha256: string; relPath: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", ticket.uploadUrl);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) setUploading({ name: file.name, percent: Math.round((event.loaded / event.total) * 100) });
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const parsed = JSON.parse(xhr.responseText) as { sha256: string; relPath: string };
              if (!parsed.sha256 || !parsed.relPath) throw new Error("上传响应缺少 sha256/relPath");
              resolve(parsed);
            } catch (err) { reject(err instanceof Error ? err : new Error("上传响应解析失败")); }
          } else {
            reject(new Error(`上传失败：HTTP ${xhr.status} ${xhr.responseText.slice(0, 160)}`));
          }
        };
        xhr.onerror = () => reject(new Error("上传网络错误"));
        xhr.send(file);
      });
      const registered = await trpc.video.media.registerUpload.mutate({
        sha256: uploaded.sha256,
        relPath: uploaded.relPath,
        kind: uploadKind as never,
        title: file.name,
        tags: ["上传"],
      });
      setNotice(`上传已入库：${(registered as { assetId: string }).assetId}`);
      void load("reset");
      void loadSide();
      void openDetail((registered as { assetId: string }).assetId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [uploadKind, load, loadSide, openDetail]);

  const kindChips = useMemo(() => KIND_ORDER.map((kind) => ({
    kind,
    active: filters.kinds.includes(kind),
  })), [filters.kinds]);

  return (
    <div className="space-y-3 px-1 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <PageExitLink label="返回工作台" />
        <h2 className="text-h1 font-black text-ink">媒资库</h2>
        <span className="text-caption text-ink3">
          {items.length} 条素材
          {quota ? ` · 占用 ${fmtBytes(quota.usedBytes)} / ${fmtBytes(quota.quotaBytes)}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="rounded-lg border border-line bg-card px-2 py-1.5 text-caption text-ink2"
            value={uploadKind}
            onChange={(event) => setUploadKind(event.target.value)}
          >
            {UPLOAD_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          <button
            type="button"
            className="wl-button wl-button--secondary cursor-pointer rounded-lg border border-line px-3 py-1.5 text-caption"
            onClick={() => fileRef.current?.click()}
            disabled={Boolean(uploading)}
          >
            {uploading ? `上传中 ${uploading.percent}%` : "上传素材"}
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </div>
      </div>

      {notice ? <BannerAlert level="info" onAction={() => setNotice(null)} actionLabel="知道了">{notice}</BannerAlert> : null}
      {error ? <BannerAlert level="alert" onAction={() => setError(null)} actionLabel="关闭">{error}</BannerAlert> : null}
      {uploading ? <BannerAlert level="warn">{`正在上传 ${uploading.name}（${uploading.percent}%）——大文件请勿关闭页面`}</BannerAlert> : null}
      {job && job.status === "running" ? (
        <BannerAlert level="info">{`重剪进行中（${job.jobId}）：${job.log.at(-1) ?? "排队中"}`}</BannerAlert>
      ) : null}

      <div className="rounded-xl border border-line bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="min-w-[220px] flex-1 rounded-lg border border-line bg-transparent px-3 py-1.5 text-body text-ink"
            placeholder="搜索标题 / 提示词（中文走子串+trgm；开启语义检索后走向量近邻）"
            value={filters.query}
            onChange={(event) => setFilters((prev) => ({ ...prev, query: event.target.value }))}
          />
          <select
            className="rounded-lg border border-line bg-transparent px-2 py-1.5 text-caption text-ink2"
            value={filters.pipeline}
            onChange={(event) => setFilters((prev) => ({ ...prev, pipeline: event.target.value }))}
          >
            <option value="">全部管线</option>
            {Object.entries(PIPELINE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select
            className="rounded-lg border border-line bg-transparent px-2 py-1.5 text-caption text-ink2"
            value={filters.source}
            onChange={(event) => setFilters((prev) => ({ ...prev, source: event.target.value }))}
          >
            <option value="">全部来源</option>
            {Object.entries(SOURCE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          {searchTrace ? (
            <span className="text-caption text-ink3">
              检索层级：{{ semantic: "语义", tsv: "全文", trgm: "模糊", none: "无" }[searchTrace.layer] ?? searchTrace.layer}
              {searchTrace.mock ? "（Mock 向量：无语义，仅链路）" : ""}
            </span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {kindChips.map(({ kind, active }) => (
            <button
              key={kind}
              type="button"
              className={`cursor-pointer rounded-full border px-2.5 py-1 text-caption ${active ? "border-holo/60 bg-holo/10 text-ink" : "border-line text-ink3"}`}
              onClick={() => setFilters((prev) => ({
                ...prev,
                kinds: prev.kinds.includes(kind) ? prev.kinds.filter((k) => k !== kind) : [...prev.kinds, kind],
              }))}
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
          {tagGroups.flatMap((group) => group.tags.slice(0, 8).map((tag) => (
            <button
              key={`${group.group}:${tag.name}`}
              type="button"
              className={`cursor-pointer rounded-full border px-2.5 py-1 text-caption ${filters.tag === tag.name ? "border-holo/60 bg-holo/10 text-ink" : "border-line text-ink3"}`}
              onClick={() => setFilters((prev) => ({ ...prev, tag: prev.tag === tag.name ? "" : tag.name }))}
            >
              #{tag.name}{tag.usage > 0 ? ` ${tag.usage}` : ""}
            </button>
          )))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div>
          {loading ? <Skeleton count={4} variant="card" label="正在加载媒资" /> : null}
          {!loading && items.length === 0 ? (
            <EmptyState
              title="还没有素材"
              description="片子跑完之后镜头片段/定妆照会自动入库；也可以直接上传本地素材。"
            />
          ) : null}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {items.map((item) => (
              <div
                key={item.id}
                className={`group cursor-pointer overflow-hidden rounded-xl border bg-card ${selected?.id === item.id ? "border-holo/60" : "border-line"}`}
                onClick={() => void openDetail(item.id)}
              >
                <div className="relative aspect-video bg-black/30">
                  {item.thumbUrl
                    ? <img src={item.thumbUrl} alt={item.title ?? item.id} className="h-full w-full object-cover" loading="lazy" />
                    : <div className="flex h-full items-center justify-center text-caption text-ink3">{KIND_LABEL[item.kind] ?? item.kind}</div>}
                  {item.durationSeconds !== null ? (
                    <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{fmtDuration(item.durationSeconds)}</span>
                  ) : null}
                  <label className="absolute left-1 top-1 flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
                    <input
                      type="checkbox"
                      checked={tray.includes(item.id)}
                      onChange={(event) => { event.stopPropagation(); toggleTray(item.id); }}
                      onClick={(event) => event.stopPropagation()}
                    />
                    片单
                  </label>
                </div>
                <div className="space-y-1 p-2">
                  <div className="flex items-center gap-1 text-[10px] text-ink3">
                    <span className="rounded bg-line/40 px-1.5 py-0.5">{KIND_LABEL[item.kind] ?? item.kind}</span>
                    {item.pipelineKind ? <span className="rounded bg-line/40 px-1.5 py-0.5">{PIPELINE_LABEL[item.pipelineKind]}</span> : null}
                    {item.sourceType === "recut" ? <span className="rounded bg-line/40 px-1.5 py-0.5">重剪</span> : null}
                    {!item.hasLocalFile ? <span className="rounded bg-amber-500/20 px-1.5 py-0.5">文件未在本机</span> : null}
                  </div>
                  <div className="line-clamp-1 text-caption font-bold text-ink">{item.title ?? item.id}</div>
                  <div className="line-clamp-2 text-[11px] text-ink3">{item.prompt ?? "（无提示词）"}</div>
                </div>
              </div>
            ))}
          </div>
          {cursor ? (
            <button
              type="button"
              className="mt-3 w-full cursor-pointer rounded-lg border border-line py-2 text-caption text-ink2"
              onClick={() => void load("more")}
              disabled={loadingMore}
            >
              {loadingMore ? "加载中…" : "加载更多"}
            </button>
          ) : null}
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-card p-3">
            <div className="text-body font-bold text-ink">详情</div>
            {!selected ? (
              <div className="mt-2 text-caption text-ink3">在左侧点选一条素材查看提示词、版本链与归档操作。</div>
            ) : (
              <div className="mt-2 space-y-2">
                <div className="text-caption font-bold text-ink">{selected.title ?? selected.id}</div>
                {selected.kind === "upload_audio" ? (
                  selected.url ? <audio controls src={selected.url} className="w-full" /> : null
                ) : selected.kind.startsWith("upload_image") || ["portrait", "cover", "product_image", "reference_image"].includes(selected.kind) ? (
                  selected.url ? <img src={selected.url} alt={selected.title ?? selected.id} className="w-full rounded-lg" /> : null
                ) : (
                  selected.url ? <video controls src={selected.url} className="w-full rounded-lg" /> : null
                )}
                <div className="text-[11px] text-ink3">
                  {KIND_LABEL[selected.kind] ?? selected.kind} · v{selected.version} · {fmtBytes(selected.bytes)}
                  {selected.width && selected.height ? ` · ${selected.width}×${selected.height}` : ""}
                  {selected.durationSeconds !== null ? ` · ${fmtDuration(selected.durationSeconds)}` : ""}
                </div>
                <div className="rounded-lg border border-line p-2">
                  <div className="flex items-center justify-between text-[11px] text-ink3">
                    <span>提示词</span>
                    <button
                      type="button"
                      className="cursor-pointer text-caption text-ink2"
                      onClick={() => {
                        void navigator.clipboard?.writeText(selected.prompt ?? "");
                        setNotice("提示词已复制，可用于复用匹配或新片开拍");
                      }}
                    >
                      复制
                    </button>
                  </div>
                  <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-ink2">{selected.prompt ?? "（无）"}</div>
                </div>
                <div className="rounded-lg border border-line p-2">
                  <div className="text-[11px] text-ink3">标签（顿号/逗号分隔）</div>
                  <input
                    className="mt-1 w-full rounded border border-line bg-transparent px-2 py-1 text-caption text-ink"
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="mt-1 cursor-pointer rounded border border-line px-2 py-1 text-caption text-ink2"
                    onClick={() => void saveTags()}
                  >
                    保存标签
                  </button>
                </div>
                <div className="rounded-lg border border-line p-2 text-[11px] text-ink3">
                  <div>版本链：{selected.versions.length} 个版本（点击「版本」查看历史）</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {selected.versions.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        className={`cursor-pointer rounded border px-1.5 py-0.5 ${v.id === selected.id ? "border-holo/60 text-ink" : "border-line"}`}
                        onClick={() => void openDetail(v.id)}
                      >
                        v{v.version}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rounded-lg border border-line p-2 text-[11px] text-ink3">
                  <div>来源：{SOURCE_LABEL[selected.sourceType] ?? selected.sourceType} · {fmtTime(selected.createdAt)}</div>
                  {selected.project ? (
                    <div className="mt-1">
                      项目：{selected.project.title}（{selected.project.id}）
                      <button
                        type="button"
                        className="ml-2 cursor-pointer text-caption text-ink2"
                        onClick={() => navigate(`/ai-video/assets?tab=studio&project=${encodeURIComponent(selected.project!.id)}`)}
                      >
                        去生产页
                      </button>
                    </div>
                  ) : null}
                  {selected.archive ? (
                    <div className="mt-1 break-all">
                      制片档案：{selected.archive.relative}{selected.archive.exists ? "" : "（目录不存在）"}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="cursor-pointer rounded border border-line px-2 py-1 text-caption text-ink2"
                    onClick={() => toggleTray(selected.id)}
                  >
                    {tray.includes(selected.id) ? "移出片单" : "加入片单"}
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer rounded border border-line px-2 py-1 text-caption text-ink2"
                    onClick={() => void archiveSelected()}
                  >
                    归档
                  </button>
                  {selected.url ? (
                    <a className="cursor-pointer rounded border border-line px-2 py-1 text-caption text-ink2" href={selected.url} download>
                      下载
                    </a>
                  ) : null}
                </div>
                {detailBusy ? <div className="text-[11px] text-ink3">正在读取详情…</div> : null}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-line bg-card p-3">
            <div className="text-body font-bold text-ink">合集</div>
            <div className="mt-2 space-y-1 text-caption text-ink3">
              {collections.length === 0 ? <div>还没有合集。勾选素材后可在下方抽屉建合集并重剪。</div> : null}
              {collections.slice(0, 6).map((c) => (
                <div key={c.id} className="flex items-center justify-between">
                  <span className="text-ink2">{c.title}</span>
                  <span>{c.itemCount} 段 · {c.status === "used" ? "已产出" : "待用"}</span>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-2 cursor-pointer rounded border border-line px-2 py-1 text-caption text-ink2"
              onClick={() => navigate("/ai-video/media/collections")}
            >
              去合集重剪台 →
            </button>
          </div>
        </aside>
      </div>

      {tray.length > 0 ? (
        <div className="sticky bottom-3 rounded-xl border border-holo/40 bg-card/95 p-3 shadow-lg backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption font-bold text-ink">本次片单：{tray.length} 段</span>
            <span className="text-[11px] text-ink3">{tray.map((id) => items.find((i) => i.id === id)?.title ?? id).join(" → ")}</span>
            <div className="ml-auto flex gap-2">
              <button type="button" className="cursor-pointer rounded border border-line px-2 py-1 text-caption text-ink2" onClick={() => setTray([])}>清空</button>
              <button
                type="button"
                className="wl-button wl-button--primary cursor-pointer rounded-lg bg-holo px-3 py-1.5 text-caption text-white"
                onClick={() => void makeCollectionAndRecut()}
                disabled={tray.length < 2}
              >
                建合集并开始重剪
              </button>
            </div>
          </div>
          {job ? (
            <div className="mt-2 max-h-24 overflow-auto text-[11px] text-ink3">
              {job.log.slice(-6).map((line, index) => <div key={index}>{line}</div>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
