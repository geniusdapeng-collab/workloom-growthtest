/**
 * 商品档案（T-2026-0926-0008）· `/ai-video/media/products`
 *
 * 数据源：`video.media.products.*`（dossier 文件的 PG 投影：文件是本体，表是发现面）。
 * 关键交互：档案卡片（主图/卖点/置信度/漂移标记）/「重新扫描」按 dossier sha256 对账 /
 *           「用此商品开拍」跳生产页并带上商品名（生产页会提示本次开拍商品）。
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { BannerAlert, EmptyState, Skeleton } from "../../../components/hud";
import { PageExitLink } from "../../../shell/PageExitLink";

interface ProductProfile {
  id: string;
  productName: string;
  /** dossier 目录名（稳定身份；重扫用它，不能用商品名） */
  dossierProductId: string | null;
  dossierPath: string;
  dossierSha256: string;
  summary: {
    name?: string | null;
    brand?: string | null;
    category?: string | null;
    priceBand?: string | null;
    sellingPoints?: string[];
    confidence?: number | string | null;
    evidenceCount?: number | null;
    gaps?: number | null;
  };
  heroAssetId: string | null;
  heroUrl: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  dossierExists: boolean;
}

export default function MediaProducts() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ProductProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [staleDays, setStaleDays] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await ensureDemoLogin();
      const result = await trpc.video.media.products.list.query();
      setItems(result.items as ProductProfile[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const refresh = useCallback(async (productId?: string) => {
    setBusy(productId ?? "all");
    try {
      const result = await trpc.video.media.products.refresh.mutate(productId ? { productId } : {});
      const failed = result.results.filter((r) => !r.ok);
      setNotice(
        failed.length === 0
          ? `重扫完成：${result.scanned} 份档案（内容有变化 ${result.results.filter((r) => r.changed).length} 份）`
          : `重扫完成：${result.scanned} 份，其中 ${failed.length} 份失败（${failed[0]?.error ?? ""}）`,
      );
      setStaleDays(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [load]);

  return (
    <div className="space-y-3 px-1 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <PageExitLink label="返回工作台" />
        <h2 className="text-h1 font-black text-ink">商品档案</h2>
        <span className="text-caption text-ink3">
          情报环节产出的 dossier 投影（文件是本体、表是发现面，按 sha256 对账）
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-caption text-ink2"
            onClick={() => void refresh()}
            disabled={busy !== null}
          >
            {busy === "all" ? "重扫中…" : "全部重新扫描"}
          </button>
          <button type="button" className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-caption text-ink2" onClick={() => navigate("/ai-video/media")}>
            去媒资库 →
          </button>
        </div>
      </div>

      {notice ? <BannerAlert level="info" onAction={() => setNotice(null)} actionLabel="知道了">{notice}</BannerAlert> : null}
      {error ? <BannerAlert level="alert" onAction={() => setError(null)} actionLabel="关闭">{error}</BannerAlert> : null}
      {staleDays !== null ? <BannerAlert level="warn">有档案超过 {staleDays} 天未重扫</BannerAlert> : null}

      {loading ? <Skeleton count={3} variant="card" label="正在加载商品档案" /> : null}
      {!loading && items.length === 0 ? (
        <EmptyState
          title="还没有商品档案"
          description="营销片跑完情报环节后，dossier 会自动投影到这里；也可以点「全部重新扫描」把历史档案补进来。"
        />
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((profile) => {
          const updated = new Date(profile.updatedAt);
          const ageDays = Math.floor((Date.now() - updated.getTime()) / 86_400_000);
          const stale = ageDays >= 30 || !profile.dossierExists;
          return (
            <div key={profile.id} className="overflow-hidden rounded-xl border border-line bg-card">
              <div className="flex gap-3 p-3">
                {profile.heroUrl
                  ? <img src={profile.heroUrl} alt={profile.productName} className="h-20 w-20 rounded-lg object-cover" />
                  : <div className="flex h-20 w-20 items-center justify-center rounded-lg bg-line/30 text-caption text-ink3">无主图</div>}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="line-clamp-1 text-body font-bold text-ink">{profile.productName}</div>
                    {stale ? <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-700">待重扫</span> : null}
                  </div>
                  <div className="text-[11px] text-ink3">
                    {profile.summary.brand ?? "品牌未知"} · {profile.summary.category ?? "类目未知"}
                    {profile.summary.priceBand ? ` · ${profile.summary.priceBand}` : ""}
                  </div>
                  <div className="mt-1 text-[11px] text-ink3">
                    置信度：{profile.summary.confidence ?? "未标注"} · 证据 {profile.summary.evidenceCount ?? "—"} 条 · 缺口 {profile.summary.gaps ?? "—"}
                  </div>
                  <div className="mt-1 text-[11px] text-ink3">更新：{updated.toLocaleString("zh-CN", { hour12: false })}（{ageDays} 天前）</div>
                </div>
              </div>
              <div className="border-t border-line px-3 py-2">
                <div className="text-[11px] text-ink3">卖点</div>
                <ul className="mt-1 space-y-0.5 text-[11px] text-ink2">
                  {(profile.summary.sellingPoints ?? []).slice(0, 4).map((point, index) => (
                    <li key={index} className="line-clamp-1">· {point}</li>
                  ))}
                  {(profile.summary.sellingPoints ?? []).length === 0 ? <li>（档案里没有可引用的卖点）</li> : null}
                </ul>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
                <button
                  type="button"
                  className="cursor-pointer rounded border border-line px-2 py-1 text-caption text-ink2"
                  onClick={() => void refresh(profile.dossierProductId ?? undefined)}
                  disabled={busy !== null}
                >
                  {busy === (profile.dossierProductId ?? "all") ? "重扫中…" : "重新扫描"}
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded border border-line px-2 py-1 text-caption text-ink2"
                  onClick={() => {
                    void navigator.clipboard?.writeText(profile.productName);
                    setNotice(`商品名已复制：${profile.productName}（开拍时粘进需求或商品字段）`);
                  }}
                >
                  复制商品名
                </button>
                <button
                  type="button"
                  className="wl-button wl-button--primary cursor-pointer rounded-lg bg-holo px-3 py-1 text-caption text-white"
                  onClick={() => navigate(`/ai-video/assets?tab=studio&product=${encodeURIComponent(profile.productName)}`)}
                >
                  用此商品开拍 →
                </button>
                <span className="w-full break-all text-[10px] text-ink3">
                  dossier：{profile.dossierPath}（sha256 {profile.dossierSha256.slice(0, 10)}…）
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
