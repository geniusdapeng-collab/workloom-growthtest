'use strict';

/**
 * DossierStore — 商品情报档案仓库
 * ------------------------------------------------------------
 * 档案落盘沉淀为可复用资产：
 *   data/dossiers/{product_id}/dossier.json      档案本体
 *   data/dossiers/{product_id}/images/manifest.json  商品图 manifest（定妆照交接物）
 *   data/dossiers/index.json                      档案索引（复用/过期判定）
 *
 * 复用纪律：
 *   - 同一 product_id 二次任务直接命中，情报环节零耗时
 *   - 默认 30 天标 stale（可通过 staleAfterDays 配置），stale 不删除，
 *     仅提示需补采，由调用方决定刷新还是沿用
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_STALE_DAYS = 30;

/**
 * 默认档案根：`<repo>/data/dossiers`。
 *
 * 【2026-09-25 修复】原默认值少写一层 `..`，解析成 `<repo>/vendor/data/dossiers`——
 * 运行期数据落进 vendor（受管第三方树）目录，vendor 升级/清理即丢档。
 * 宿主若需要（如按工作区隔离），应显式传 `storeRoot`；本默认值只作为单机兜底。
 */
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', 'data', 'dossiers');

/** 原子写：先写临时文件再 rename，避免进程中断留下半截 JSON */
function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

class DossierStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.root] 仓库根目录（默认 <repo>/data/dossiers）
   * @param {number} [opts.staleAfterDays] 过期天数（默认 30）
   */
  constructor(opts = {}) {
    this.root = opts.root || DEFAULT_ROOT;
    this.staleAfterDays = Number(opts.staleAfterDays) > 0 ? Number(opts.staleAfterDays) : DEFAULT_STALE_DAYS;
  }

  _dir(productId) {
    const safe = String(productId).replace(/[^\w-]/g, '_');
    return path.join(this.root, safe);
  }

  _readIndex() {
    const fp = path.join(this.root, 'index.json');
    if (!fs.existsSync(fp)) return { entries: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
      return { ...parsed, entries: Array.isArray(parsed && parsed.entries) ? parsed.entries : [] };
    } catch (e) {
      // 索引损坏不应静默当成空索引（否则下一次 save 会抹掉既有登记）——改名留证后重建
      const corrupt = `${fp}.corrupt-${Date.now()}`;
      try { fs.renameSync(fp, corrupt); } catch { /* 留证失败不阻断重建 */ }
      return { entries: [], recovered_from: corrupt };
    }
  }

  _writeIndex(index) {
    fs.mkdirSync(this.root, { recursive: true });
    writeJsonAtomic(path.join(this.root, 'index.json'), index);
  }

  /** 保存档案（覆盖式，index 同步更新） */
  save(dossier) {
    if (!dossier || !dossier.product_id) throw new Error('[DossierStore] 档案缺 product_id，拒绝落盘');
    const dir = this._dir(dossier.product_id);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    writeJsonAtomic(path.join(dir, 'dossier.json'), dossier);

    // 商品图 manifest 单独成文：定妆照分支的交接物
    const manifest = {
      product_id: dossier.product_id,
      hero_image_id: dossier.visual_assets.hero_image_id,
      needs_more_reference: dossier.visual_assets.needs_more_reference,
      reference_images: dossier.visual_assets.images.map(img => ({
        id: img.id, url: img.url, source: img.source, angle: img.angle,
        license_risk: img.license_risk, fetched_at: img.fetched_at
      })),
      exported_at: new Date().toISOString()
    };
    writeJsonAtomic(path.join(dir, 'images', 'manifest.json'), manifest);

    const index = this._readIndex();
    index.entries = index.entries.filter(e => e.product_id !== dossier.product_id);
    index.entries.push({
      product_id: dossier.product_id,
      name: dossier.identity.name,
      category: dossier.identity.category || '',
      built_at: dossier.built_at || new Date().toISOString(),
      image_count: dossier.visual_assets.images.length,
      stale: false
    });
    index.updated_at = new Date().toISOString();
    this._writeIndex(index);
    return { dir, dossierPath: path.join(dir, 'dossier.json'), manifestPath: path.join(dir, 'images', 'manifest.json') };
  }

  /** 读取档案；不存在返回 null；过期标记 stale 一并返回 */
  load(productId) {
    const fp = path.join(this._dir(productId), 'dossier.json');
    if (!fs.existsSync(fp)) return null;
    const dossier = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const stale = this.isStale(dossier);
    return { dossier, stale, path: fp };
  }

  exists(productId) {
    return fs.existsSync(path.join(this._dir(productId), 'dossier.json'));
  }

  isStale(dossier) {
    if (!dossier || !dossier.built_at) return true;
    const ageMs = Date.now() - new Date(dossier.built_at).getTime();
    return ageMs > this.staleAfterDays * 24 * 3600 * 1000;
  }

  /** 索引清单（含 stale 实时判定） */
  list() {
    const index = this._readIndex();
    return index.entries.map(e => {
      const loaded = this.load(e.product_id);
      return { ...e, stale: loaded ? loaded.stale : true };
    });
  }
}

module.exports = { DossierStore, DEFAULT_STALE_DAYS };
