/**
 * 媒资库活库契约（T-2026-0926-0007…0010）：真 PG 上跑完入库 → 检索 → 合集 → 重剪 → 交付包 → 同步。
 *
 * 覆盖不变量：
 *  ① 一切入库走 register()（sha256 幂等；重复登记不覆盖用户改名成果）；
 *  ② 三层检索：结构化过滤 + tsv/trgm（中文子串）+（可选）语义；
 *  ③ 写操作与五元事件同一事务（asset.update_meta / asset.archive / collection.* 可在 biz_events 反查到）；
 *  ④ 合集顺序即重剪顺序（reorder 必须整集合一致，防静默丢条目）；
 *  ⑤ 重剪作业真实跑 ffmpeg（无 ffmpeg 环境跳过，不伪装成功）；
 *  ⑥ 云端同步：LWW 冲突不静默覆盖 + 文件按需拉取必须 sha256 校验通过才认账；
 *  ⑦ 交付包（母版/变体/封面）登记为 final_cut/cover，provenance 记录来源；
 *  ⑧ RLS 安全默认：他工作区看不到本工作区的素材。
 *
 * 说明：本文件用 RUN_DB_TESTS=1 打开（与仓内既有 *.pg.test.ts 同口径）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { isoOf } from "./sync.js";
import { scopedDeliveryRoot } from "../delivery-trust.js";
import { seedTestPackage, TEST_DELIVERY_SECRET } from "../delivery-fixture.test-support.js";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
process.env.DATABASE_GATEWAY_URL ??= "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";
process.env.MEDIA_SIGNING_SECRET ??= "test-media-signing-secret";
process.env.WORKLOOM_DELIVERY_SIGNING_SECRET = TEST_DELIVERY_SECRET;

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const MEDIA_DIR = mkdtempSync(join(tmpdir(), "media-pg-"));
const TMP = mkdtempSync(join(tmpdir(), "media-pg-fixture-"));
process.env.WORKLOOM_MEDIA_DIR = MEDIA_DIR;
process.env.WORKLOOM_DELIVERY_DIR = join(TMP, "delivery");

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(RUN_DB)("媒资库活库契约", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenantId = `tenant-media-${suffix}`;
  const workspaceId = `ws-media-${suffix}`;
  const otherWorkspaceId = `ws-media-other-${suffix}`;
  const otherTenantId = `tenant-media-other-${suffix}`;
  const projectId = `VID-MD-${suffix.slice(-6)}`;
  const scope = { tenantId, workspaceId };
  const otherScope = { tenantId: otherTenantId, workspaceId: otherWorkspaceId };

  let mods: {
    registerLocalAsset: typeof import("./register-local.js").registerLocalAsset;
    registerUploadedAsset: typeof import("./upload.js").registerUploadedAsset;
    checkUploadQuota: typeof import("./upload.js").checkUploadQuota;
    uploadRelPath: typeof import("./upload.js").uploadRelPath;
    cleanupStaleUploads: typeof import("./upload.js").cleanupStaleUploads;
    backfillEmbeddings: typeof import("./embed.js").backfillEmbeddings;
    listAssets: typeof import("./library.js").listAssets;
    listFilms: typeof import("./library.js").listFilms;
    getAsset: typeof import("./library.js").getAsset;
    updateAssetMeta: typeof import("./library.js").updateAssetMeta;
    archiveAsset: typeof import("./library.js").archiveAsset;
    tagGroups: typeof import("./library.js").tagGroups;
    createCollection: typeof import("./collections.js").createCollection;
    addCollectionItem: typeof import("./collections.js").addCollectionItem;
    reorderCollection: typeof import("./collections.js").reorderCollection;
    getCollection: typeof import("./collections.js").getCollection;
    upsertProductProfileFromDossier: typeof import("./products.js").upsertProductProfileFromDossier;
    findReusable: typeof import("./reuse.js").findReusable;
    startRecut: typeof import("./recut.js").startRecut;
    recutJob: typeof import("./recut.js").recutJob;
    ingestDeliveryPackage: typeof import("./ingest-delivery.js").ingestDeliveryPackage;
    changesSince: typeof import("./sync.js").changesSince;
    applyPush: typeof import("./sync.js").applyPush;
    ensureAssetFile: typeof import("./sync.js").ensureAssetFile;
    reconcile: typeof import("./sync.js").reconcile;
    enrollDevice: typeof import("./sync.js").enrollDevice;
    verifyDeviceRequest: typeof import("./sync.js").verifyDeviceRequest;
    deviceKeyFor: typeof import("./sync.js").deviceKeyFor;
    deviceSignature: typeof import("./sync.js").deviceSignature;
    bodyHash: typeof import("./sync.js").bodyHash;
    sha256File: typeof import("./register-local.js").sha256File;
  };
  let getAppPool: typeof import("@workloom/db").getAppPool;
  let getGatewayPool: typeof import("@workloom/db").getGatewayPool;

  const clipIds: string[] = [];

  async function writeFixtureFile(name: string, content: string): Promise<string> {
    const file = join(TMP, name);
    writeFileSync(file, content, "utf8");
    return file;
  }

  async function makeTinyClip(name: string, color: string): Promise<string> {
    const file = join(TMP, name);
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${color}:s=320x240:d=1:r=15`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
    ], { stdio: "ignore" });
    return file;
  }

  beforeAll(async () => {
    mods = {
      registerLocalAsset: (await import("./register-local.js")).registerLocalAsset,
      registerUploadedAsset: (await import("./upload.js")).registerUploadedAsset,
      checkUploadQuota: (await import("./upload.js")).checkUploadQuota,
      uploadRelPath: (await import("./upload.js")).uploadRelPath,
      cleanupStaleUploads: (await import("./upload.js")).cleanupStaleUploads,
      backfillEmbeddings: (await import("./embed.js")).backfillEmbeddings,
      listAssets: (await import("./library.js")).listAssets,
      listFilms: (await import("./library.js")).listFilms,
      getAsset: (await import("./library.js")).getAsset,
      updateAssetMeta: (await import("./library.js")).updateAssetMeta,
      archiveAsset: (await import("./library.js")).archiveAsset,
      tagGroups: (await import("./library.js")).tagGroups,
      createCollection: (await import("./collections.js")).createCollection,
      addCollectionItem: (await import("./collections.js")).addCollectionItem,
      reorderCollection: (await import("./collections.js")).reorderCollection,
      getCollection: (await import("./collections.js")).getCollection,
      upsertProductProfileFromDossier: (await import("./products.js")).upsertProductProfileFromDossier,
      findReusable: (await import("./reuse.js")).findReusable,
      startRecut: (await import("./recut.js")).startRecut,
      recutJob: (await import("./recut.js")).recutJob,
      ingestDeliveryPackage: (await import("./ingest-delivery.js")).ingestDeliveryPackage,
      changesSince: (await import("./sync.js")).changesSince,
      applyPush: (await import("./sync.js")).applyPush,
      ensureAssetFile: (await import("./sync.js")).ensureAssetFile,
      reconcile: (await import("./sync.js")).reconcile,
      enrollDevice: (await import("./sync.js")).enrollDevice,
      verifyDeviceRequest: (await import("./sync.js")).verifyDeviceRequest,
      deviceKeyFor: (await import("./sync.js")).deviceKeyFor,
      deviceSignature: (await import("./sync.js")).deviceSignature,
      bodyHash: (await import("./sync.js")).bodyHash,
      sha256File: (await import("./register-local.js")).sha256File,
    };
    ({ getAppPool, getGatewayPool } = await import("@workloom/db"));

    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'community')`, [tenantId, "媒资契约租户"]);
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'community')`, [otherTenantId, "媒资越权租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,'媒资契约工作区',$3,'general')`,
      [workspaceId, tenantId, `media-${suffix}`],
    );
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,'邻居工作区',$3,'general')`,
      [otherWorkspaceId, otherTenantId, `media-other-${suffix}`],
    );
    await owner.query(
      `INSERT INTO video_projects (id, workspace_id, title, kind, created_by) VALUES ($1,$2,'媒资契约片','marketing','MEM-T')`,
      [projectId, workspaceId],
    );
  }, 60_000);

  afterAll(async () => {
    // 具名清理：失败即抛（旧实现 9 处 .catch(() => undefined) 静默吞错 → 实测留下残留 workspace）
    const cleanup: Array<[string, string, unknown[]]> = [
      ["collection_items", `DELETE FROM media_collection_items WHERE workspace_id = ANY($1::text[])`, [[workspaceId, otherWorkspaceId]]],
      ["collections", `DELETE FROM media_collections WHERE workspace_id = ANY($1::text[])`, [[workspaceId, otherWorkspaceId]]],
      ["product_profiles", `DELETE FROM media_product_profiles WHERE workspace_id = ANY($1::text[])`, [[workspaceId, otherWorkspaceId]]],
      ["tags", `DELETE FROM media_tags WHERE workspace_id = ANY($1::text[])`, [[workspaceId, otherWorkspaceId]]],
      ["sync_devices", `DELETE FROM media_sync_devices WHERE workspace_id = ANY($1::text[])`, [[workspaceId, otherWorkspaceId]]],
      ["sync_log", `DELETE FROM media_sync_log WHERE workspace_id = ANY($1::text[])`, [[workspaceId, otherWorkspaceId]]],
      ["assets", `DELETE FROM video_assets WHERE workspace_id = ANY($1::text[])`, [[workspaceId, otherWorkspaceId]]],
      ["projects", `DELETE FROM video_projects WHERE workspace_id = ANY($1::text[])`, [[workspaceId, otherWorkspaceId]]],
      ["workspaces", `DELETE FROM workspaces WHERE id = ANY($1::text[])`, [[workspaceId, otherWorkspaceId]]],
      ["tenants", `DELETE FROM tenants WHERE id = ANY($1::text[])`, [[tenantId, otherTenantId]]],
    ];
    const cleanupErrors: string[] = [];
    for (const [label, sql, params] of cleanup) {
      try { await owner.query(sql, params); } catch (err) { cleanupErrors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    expect(cleanupErrors, `夹具清理必须干净（残留会污染后续用例）：${cleanupErrors.join("；")}`).toEqual([]);
    await owner.end();
    rmSync(MEDIA_DIR, { recursive: true, force: true });
    rmSync(TMP, { recursive: true, force: true });
  }, 60_000);

  it("① 入库：register 幂等 + 媒资列补写 + 版本链可查", async () => {
    const file = await writeFixtureFile("clip-a.mp4", "clip-bytes-a");
    const first = await mods.registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
      absPath: file,
      kind: "clip",
      title: "实验室讲解 · 近景",
      tags: ["口播", "实验室"],
      prompt: "主持人在实验室里讲解折叠电煮锅的加热结构",
      pipelineKind: "marketing",
      projectId,
      sourceType: "generated",
      by: "vitest",
      probe: false,
      thumbnail: false,
    });
    clipIds.push(first.assetId);
    const row = await owner.query(
      `SELECT title, tags, prompt, pipeline_kind, source_type, kind, meta->>'localPath' AS local_path, sha256
         FROM video_assets WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, first.assetId]);
    expect(row.rows[0].title).toBe("实验室讲解 · 近景");
    expect(row.rows[0].pipeline_kind).toBe("marketing");
    expect(row.rows[0].kind).toBe("clip");
    expect(row.rows[0].source_type).toBe("generated");
    expect(row.rows[0].local_path).toBe(first.relPath);
    expect(existsSync(join(MEDIA_DIR, first.relPath))).toBe(true);

    // 幂等：同内容再登记一次 → deduped，且**不覆盖**用户改名成果
    await mods.updateAssetMeta(getAppPool(), scope, { assetId: first.assetId, title: "用户改过的名字", by: "MEM-T" });
    const second = await mods.registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
      absPath: file, kind: "clip", title: "自动生成的名字", prompt: "别的提示词", by: "render-poller",
      probe: false, thumbnail: false,
    });
    expect(second.deduped).toBe(true);
    expect(second.assetId).toBe(first.assetId);
    const after = await owner.query(`SELECT title FROM video_assets WHERE workspace_id=$1 AND id=$2`, [workspaceId, first.assetId]);
    expect(after.rows[0].title).toBe("用户改过的名字");
  }, 60_000);

  it("② 检索：中文子串/trgm 命中、结构化过滤正确、归档后默认不返回", async () => {
    const list = await mods.listAssets(getAppPool(), scope, { query: "实验室" });
    expect(list.items.map((i) => i.id)).toContain(clipIds[0]);
    expect(list.searchTrace?.layer).not.toBe("semantic");

    const byTag = await mods.listAssets(getAppPool(), scope, { tags: ["口播"], kind: ["clip"] });
    expect(byTag.items.map((i) => i.id)).toContain(clipIds[0]);
    const byPipeline = await mods.listAssets(getAppPool(), scope, { pipelineKind: "narrative" });
    expect(byPipeline.items.map((i) => i.id)).not.toContain(clipIds[0]);

    const tags = await mods.tagGroups(getAppPool(), scope);
    expect(tags.flatMap((g) => g.tags.map((t) => t.name))).toContain("实验室");

    const detail = await mods.getAsset(getAppPool(), scope, clipIds[0]!);
    expect(detail?.project?.id).toBe(projectId);
    expect(detail?.versions.length).toBe(1);
  }, 60_000);

  it("③ 写操作与事件同事务（biz_events 可反查）", async () => {
    await mods.archiveAsset(getAppPool(), scope, { assetId: clipIds[0]!, by: "MEM-T" });
    const list = await mods.listAssets(getAppPool(), scope, {});
    expect(list.items.map((i) => i.id)).not.toContain(clipIds[0]);
    const archived = await mods.listAssets(getAppPool(), scope, { status: "archived" });
    expect(archived.items.map((i) => i.id)).toContain(clipIds[0]);
    const events = await owner.query<{ action: string }>(
      `SELECT payload->'decision'->>'action' AS action FROM biz_events
        WHERE workspace_id = $1 AND payload->'decision'->'after'->>'assetId' = $2`,
      [workspaceId, clipIds[0]]);
    const actions = events.rows.map((r) => r.action);
    expect(actions).toContain("asset.update_meta");
    expect(actions).toContain("asset.archive");
    // 复位，后续用例继续用这两段素材
    await owner.query(`UPDATE video_assets SET status='registered' WHERE workspace_id=$1 AND id=$2`, [workspaceId, clipIds[0]]);
  }, 60_000);

  it("④ 合集：顺序即重剪顺序，重排必须整集合一致", async () => {
    const fileB = await writeFixtureFile("clip-b.mp4", "clip-bytes-b");
    const fileC = await writeFixtureFile("clip-c.mp4", "clip-bytes-c");
    const b = await mods.registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
      absPath: fileB, kind: "clip", title: "第二段", prompt: "实验室外景", by: "vitest", probe: false, thumbnail: false,
    });
    const c = await mods.registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
      absPath: fileC, kind: "clip", title: "第三段", prompt: "产品特写", by: "vitest", probe: false, thumbnail: false,
    });
    clipIds.push(b.assetId, c.assetId);
    const collection = await mods.createCollection(getAppPool(), scope, { title: "契约片单", by: "MEM-T" });
    for (const id of clipIds.slice(0, 3)) {
      await mods.addCollectionItem(getAppPool(), scope, { collectionId: collection.id, assetId: id, by: "MEM-T" });
    }
    await expect(mods.reorderCollection(getAppPool(), scope, {
      collectionId: collection.id, orderedAssetIds: [clipIds[0]!, clipIds[1]!], by: "MEM-T",
    })).rejects.toThrow(/完全一致/);

    const reversed = [...clipIds.slice(0, 3)].reverse();
    await mods.reorderCollection(getAppPool(), scope, { collectionId: collection.id, orderedAssetIds: reversed, by: "MEM-T" });
    const detail = await mods.getCollection(getAppPool(), scope, collection.id);
    expect(detail?.items.map((item) => item.asset_id)).toEqual(reversed);

    const collectionEvents = await owner.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM biz_events
        WHERE workspace_id = $1 AND payload->'decision'->>'action' = 'collection.reorder'`,
      [workspaceId]);
    expect(Number(collectionEvents.rows[0]?.n ?? 0)).toBeGreaterThan(0);
  }, 60_000);

  it("⑤ 商品档案：dossier 投影 + sha256 对账 + 主图入库", async () => {
    const dossierRoot = join(TMP, "dossiers", workspaceId);
    const productId = "PRD-MEDIA-1";
    mkdirSync(join(dossierRoot, productId, "images"), { recursive: true });
    writeFileSync(join(dossierRoot, productId, "images", "hero.png"), "fake-png-bytes", "utf8");
    writeFileSync(join(dossierRoot, productId, "images", "manifest.json"), JSON.stringify({
      product_id: productId,
      hero_image_id: "img-1",
      reference_images: [{ id: "img-1", url: "https://example.invalid/hero.png", angle: "front" }],
    }), "utf8");
    writeFileSync(join(dossierRoot, productId, "dossier.json"), JSON.stringify({
      product_id: productId,
      identity: { name: "折叠电煮锅", brand: "山野", category: "厨具" },
      selling_points: ["一键折叠"],
      confidence: 0.7,
      provenance: [{ url: "https://example.com/a" }],
      visual_assets: { hero_image_id: "img-1", images: [] },
    }), "utf8");

    const first = await mods.upsertProductProfileFromDossier(getAppPool(), getGatewayPool(), scope, {
      dossierRoot, productId, by: "video-studio", fetchHero: false,
    });
    expect(first.profile.productName).toBe("折叠电煮锅");
    expect(first.changed).toBe(true);
    expect(first.profile.heroAssetId).not.toBeNull();
    expect(first.profile.summary.sellingPoints).toEqual(["一键折叠"]);

    const second = await mods.upsertProductProfileFromDossier(getAppPool(), getGatewayPool(), scope, {
      dossierRoot, productId, by: "video-studio", fetchHero: false,
    });
    expect(second.changed).toBe(false);
    expect(second.profile.id).toBe(first.profile.id);
  }, 60_000);

  it("⑥ 复用匹配：同主题命中 clip，归档/成片不进候选", async () => {
    // 同一条提示词 → trgm 相似度 1.0，必然命中（这是"复用不重渲"的地基）
    const hits = await mods.findReusable(getAppPool(), scope, {
      prompt: "主持人在实验室里讲解折叠电煮锅的加热结构", limit: 5,
    });
    expect(hits.map((hit) => hit.assetId)).toContain(clipIds[0]);
    expect(hits.every((hit) => hit.similarity >= 0.25)).toBe(true);
    // 不相干的提示词不该被硬凑成命中
    const unrelated = await mods.findReusable(getAppPool(), scope, { prompt: "深海潜水的鲸鱼", limit: 5 });
    expect(unrelated.map((hit) => hit.assetId)).not.toContain(clipIds[0]);
  }, 60_000);

  it("⑦ 上传：配额闸 + 归属/指纹复核", async () => {
    const content = "uploaded-video-bytes";
    const file = await writeFixtureFile("upload.mp4", content);
    const sha256 = await mods.sha256File(file);
    const relPath = mods.uploadRelPath(workspaceId, sha256, "upload.mp4");
    const abs = join(MEDIA_DIR, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");

    const registered = await mods.registerUploadedAsset(getAppPool(), getGatewayPool(), scope, {
      sha256, relPath, kind: "upload_video", title: "用户上传样片", tags: ["上传"],
    }, "MEM-T");
    expect(registered.assetId).toBeTruthy();
    const row = await owner.query(
      `SELECT source_type, license_risk, kind FROM video_assets WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, registered.assetId]);
    expect(row.rows[0].source_type).toBe("uploaded");
    expect(row.rows[0].license_risk).toBe("unknown");

    // 越权路径：把 relPath 换成别的工作区 → 拒绝
    await expect(mods.registerUploadedAsset(getAppPool(), getGatewayPool(), scope, {
      sha256, relPath: mods.uploadRelPath(otherWorkspaceId, sha256, "x.mp4"), kind: "upload_video",
    }, "MEM-T")).rejects.toThrow(/不属于当前工作区/);

    // 指纹不符：声明另一份 sha → 拒绝
    await expect(mods.registerUploadedAsset(getAppPool(), getGatewayPool(), scope, {
      sha256: "0".repeat(64), relPath, kind: "upload_video",
    }, "MEM-T")).rejects.toThrow(/指纹不一致/);

    const quota = await mods.checkUploadQuota(getAppPool(), scope, 1024, { WORKLOOM_MEDIA_QUOTA_GB: "0.0000001" });
    expect(quota.ok).toBe(false);
    expect(quota.reason).toMatch(/配额不足/);
  }, 60_000);

  it("⑧ 交付包：母版/变体/封面登记为 final_cut/cover，重复登记幂等", async () => {
    const pkg = join(scopedDeliveryRoot(join(TMP, "delivery"), scope), `pkg-${suffix}`);
    seedTestPackage(pkg, scope, projectId);
    await expect(mods.ingestDeliveryPackage(getAppPool(), getGatewayPool(), otherScope, { dir: pkg, by: "delivery" })).rejects.toThrow(/工作区/);
    const first = await mods.ingestDeliveryPackage(getAppPool(), getGatewayPool(), scope, { dir: pkg, by: "delivery" });
    expect(first.registered.map((r) => r.role).sort()).toEqual(["cover", "cover", "cover", "master", "variant", "variant", "variant"]);
    expect(first.errors).toEqual([]);
    const films = await mods.listAssets(getAppPool(), scope, { kind: ["final_cut"] });
    expect(films.items.length).toBeGreaterThanOrEqual(2);
    expect(films.items.some((item) => item.sourceType === "generated")).toBe(true);

    const second = await mods.ingestDeliveryPackage(getAppPool(), getGatewayPool(), scope, { dir: pkg, by: "delivery" });
    expect(second.registered.every((r) => r.deduped)).toBe(true);
  }, 60_000);

  it("⑨ 同步：增量拉取 + LWW 冲突 + 文件按需拉取 sha256 校验 + 设备签名", async () => {
    const changes = await mods.changesSince(getAppPool(), scope, { limit: 100 });
    expect(changes.assets.length).toBeGreaterThan(0);
    expect(changes.cursor).toBeTruthy();

    // 设备登记 + 签名校验（含时间戳偏移与篡改拒绝）
    const device = await mods.enrollDevice(getAppPool(), scope, { label: "测试机", by: "MEM-T" });
    const key = mods.deviceKeyFor(device.deviceId);
    const timestamp = String(Date.now());
    const bodyText = JSON.stringify({ assets: [] });
    const signature = mods.deviceSignature({
      method: "POST", path: "/sync/media/push", timestamp, bodySha256: mods.bodyHash(bodyText),
    }, key);
    const ok = await mods.verifyDeviceRequest(owner, {
      deviceId: device.deviceId, timestamp, signature, method: "POST", path: "/sync/media/push", body: bodyText,
    });
    expect(ok.ok).toBe(true);
    const badSig = await mods.verifyDeviceRequest(owner, {
      deviceId: device.deviceId, timestamp, signature: "deadbeef", method: "POST", path: "/sync/media/push", body: bodyText,
    });
    expect(badSig.ok).toBe(false);
    expect(badSig.code).toBe("DEVICE_BAD_SIGNATURE");
    const skewed = await mods.verifyDeviceRequest(owner, {
      deviceId: device.deviceId, timestamp: String(Date.now() - 10 * 60 * 1000), signature, method: "POST", path: "/sync/media/push", body: bodyText,
    });
    expect(skewed.code).toBe("DEVICE_TIMESTAMP_SKEW");

    // LWW：先推一行"更旧"的 → 冲突；再推"更新"的 → 落库
    const target = clipIds[1]!;
    const current = await owner.query(`SELECT updated_at FROM video_assets WHERE workspace_id=$1 AND id=$2`, [workspaceId, target]);
    const older = new Date(Date.parse(current.rows[0].updated_at) - 60_000).toISOString();
    const baseRow = {
      id: target, project_id: null, chain_id: target, kind: "clip", version: 1, parent_id: null,
      source_url: "local://x", provenance: {}, license_risk: "none", hero_image_id: null,
      sha256: "f".repeat(64), meta: {}, status: "registered", created_by: "device", created_at: older,
      updated_at: older, title: "云端标题", tags: [], prompt: null, pipeline_kind: null,
      duration_seconds: null, width: null, height: null, thumb_path: null, source_type: "generated",
      sync_state: "cloud_only",
    };
    const conflicted = await mods.applyPush(getAppPool(), scope, { assets: [baseRow as never] }, "device-A");
    expect(conflicted.conflicts.map((c) => c.table)).toContain("assets");
    expect(conflicted.applied.assets).toBe(0);

    const newer = new Date(Date.parse(current.rows[0].updated_at) + 60_000).toISOString();
    const applied = await mods.applyPush(getAppPool(), scope, { assets: [{ ...baseRow, updated_at: newer, created_at: newer } as never] }, "device-A");
    expect(applied.applied.assets).toBe(1);
    const afterPush = await owner.query(`SELECT title, sync_state FROM video_assets WHERE workspace_id=$1 AND id=$2`, [workspaceId, target]);
    expect(afterPush.rows[0].title).toBe("云端标题");

    // 文件按需拉取：sha 不符即拒且不留文件；相符则落盘并置 synced
    const localPath = (await owner.query<{ local_path: string }>(
      `SELECT meta->>'localPath' AS local_path FROM video_assets WHERE workspace_id=$1 AND id=$2`, [workspaceId, clipIds[2]!])).rows[0]!.local_path;
    rmSync(join(MEDIA_DIR, localPath), { force: true });
    const wrong = await mods.ensureAssetFile(getAppPool(), scope, {
      assetId: clipIds[2]!, cloudBaseUrl: "http://cloud.test", remoteUrl: "/media/x?token=t",
      fetchImpl: async () => new Response("wrong-bytes"),
    });
    expect(wrong.ok).toBe(false);
    expect(existsSync(join(MEDIA_DIR, localPath))).toBe(false);

    const right = await mods.ensureAssetFile(getAppPool(), scope, {
      assetId: clipIds[2]!, cloudBaseUrl: "http://cloud.test", remoteUrl: "/media/x?token=t",
      fetchImpl: async () => new Response("clip-bytes-c"),
    });
    expect(right.ok).toBe(true);
    expect(existsSync(join(MEDIA_DIR, localPath))).toBe(true);
    const synced = await owner.query(`SELECT sync_state FROM video_assets WHERE workspace_id=$1 AND id=$2`, [workspaceId, clipIds[2]!]);
    expect(synced.rows[0].sync_state).toBe("synced");

    // 对账：把远端 sha 换成另一个值 → 报漂移
    const remote = await mods.changesSince(getAppPool(), scope, { limit: 100 });
    const tampered = { ...remote, assets: remote.assets.map((a) => (a.id === clipIds[2] ? { ...a, sha256: "f".repeat(64) } : a)) };
    const report = await mods.reconcile(getAppPool(), scope, tampered);
    expect(report.shaMismatch.map((m) => m.id)).toContain(clipIds[2]);

    const logCount = await owner.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM media_sync_log WHERE workspace_id=$1`, [workspaceId]);
    expect(Number(logCount.rows[0]?.n ?? 0)).toBeGreaterThan(0);
  }, 120_000);

  it("⑩ RLS：他工作区看不到本工作区素材；越权 get 返回 null", async () => {
    const other = await mods.listAssets(getAppPool(), otherScope, {});
    expect(other.items.length).toBe(0);
    const detail = await mods.getAsset(getAppPool(), otherScope, clipIds[0]!);
    expect(detail).toBeNull();
  }, 60_000);

  /**
   * 分页回归（T-2026-0926-0011 深审发现）：`nextCursor` 曾把 JS Date 的 toString()
   * 拼进去（"Sat Sep … GMT+0800 (China Standard Time)|VA-…"），第二页 `::timestamptz`
   * 直接 22023 → 媒资库/成片历史「加载更多」必崩。这里锁死：游标必须是 ISO，
   * 且两页并集 == 全量、无重复。
   */
  it("⑫ 分页游标必须是 ISO 且翻页并集等于全量（列表/检索/成片）", async () => {
    // 造 5 条 clip（其中 3 条命中中文检索），保证必然分页
    for (const index of [0, 1, 2]) {
      const file = await writeFixtureFile(`page-${index}.mp4`, `page-bytes-${index}`);
      await mods.registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
        absPath: file, kind: "clip", title: `分页素材 ${index}`, prompt: "分页实验室素材", by: "vitest",
        probe: false, thumbnail: false,
      });
    }
    const pageProbe = await mods.listAssets(getAppPool(), scope, { limit: 2 });
    expect(pageProbe.nextCursor, "limit 命中时必须给出游标").toBeTruthy();
    expect(pageProbe.nextCursor!).toMatch(/^(semantic|tsv|trgm|none)\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|/);

    const walk = async (input: { limit: number; query?: string; status?: "active" | "archived" | "all" }) => {
      const seen: string[] = [];
      const layers: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const result = await mods.listAssets(getAppPool(), scope, { ...input, cursor: cursor ?? undefined });
        seen.push(...result.items.map((item) => item.id));
        if (result.searchTrace?.layer) layers.push(result.searchTrace.layer);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return { seen, layers };
    };
    for (const input of [{ limit: 2 }, { limit: 3 }]) {
      const { seen, layers } = await walk(input);
      const full = (await mods.listAssets(getAppPool(), scope, { limit: 200 })).items.map((item) => item.id).sort();
      expect(new Set(seen).size, `分页不应重复 id（input=${JSON.stringify(input)}）`).toBe(seen.length);
      expect([...seen].sort(), `分页并集必须等于全量（input=${JSON.stringify(input)}）`).toEqual(full);
      expect(new Set(layers).size, "同一轮翻页不得跨检索层").toBeLessThanOrEqual(1);
    }
    // 带检索的翻页：并集必须等于**该检索**的全量，且层必须稳定（不得 tsv→trgm 漂移）
    for (const query of ["实验室", "实验"]) {
      const { seen, layers } = await walk({ limit: 2, query });
      const full = (await mods.listAssets(getAppPool(), scope, { limit: 200, query })).items.map((item) => item.id).sort();
      expect(new Set(seen).size, `检索分页不应重复（query=${query}）`).toBe(seen.length);
      expect([...seen].sort(), `检索分页并集必须等于该检索全量（query=${query}）`).toEqual(full);
      expect(new Set(layers).size, `检索翻页不得跨层（query=${query}，实际 ${layers.join("→")}）`).toBeLessThanOrEqual(1);
    }

    // 成片历史同款游标
    const films = await mods.listFilms(getAppPool(), scope, { limit: 1 });
    if (films.nextCursor) {
      expect(films.nextCursor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|/);
      const second = await mods.listFilms(getAppPool(), scope, { limit: 1, cursor: films.nextCursor });
      expect(second.items.every((item) => item.id !== films.items[0]?.id)).toBe(true);
    }
  }, 120_000);

  /**
   * 同步增量游标回归（T-2026-0926-0012 深审实证）：触发器把 updated_at 写成事务时间，
   * 同一事务写入的多行时间戳**完全相同**；旧实现用"全局 max(updated_at) + 严格大于"做游标，
   * 同刻行数 > limit 时页与页原地打转（hasMore 恒 true），这些行永远同步不过去。
   */
  it("⑬ 同步增量游标：同刻批量写入也必须能推进（不丢行/不死循环）", async () => {
    const tx = await owner.connect();
    const ids = [`VA-tx-a-${suffix}`, `VA-tx-b-${suffix}`, `VA-tx-c-${suffix}`];
    try {
      await tx.query("BEGIN");
      for (const [index, id] of ids.entries()) {
        await tx.query(
          `INSERT INTO video_assets (id, workspace_id, chain_id, kind, version, source_url, sha256, meta, status, created_by, title)
           VALUES ($1,$2,$1,'clip',1,'local://tx',$3,'{"localPath":"video/x/tx.mp4"}','registered','vitest',$4)`,
          [id, workspaceId, `sha-tx-${index}-${suffix}`, `同刻素材 ${index}`]);
      }
      await tx.query("COMMIT");
    } finally {
      tx.release();
    }

    const seen = new Set<string>();
    const pages: number[] = [];
    let cursor: string | null = new Date(Date.now() - 60_000).toISOString();
    let guard = 0;
    while (cursor && guard < 40) {
      guard += 1;
      const page = await mods.changesSince(getAppPool(), scope, { since: cursor, limit: 2 });
      pages.push(page.assets.length);
      for (const asset of page.assets) seen.add(asset.id);
      cursor = page.hasMore ? page.cursor : null;
    }
    // 三条同刻行都必须被拉到（旧实现会卡在同一页）
    for (const id of ids) expect(seen.has(id), `同刻批量行 ${id} 必须被增量游标拉到`).toBe(true);
    // 必须能收敛（旧实现 hasMore 恒 true → 这里会跑满 guard）
    expect(cursor).toBeNull();
    expect(guard).toBeLessThan(40);
  }, 90_000);

  /**
   * 推送隔离回归（T-2026-0926-0013 深审实证）：同批出现重复 sha256 会让整个 push 500，
   * 且已写入的行不回滚；`applied` 也曾与实际写入不符。现在要求：坏行只影响自己。
   */
  it("⑭ 推送逐行隔离：重复 sha256 降级为冲突，坏行进 failed[]，好行照常落库", async () => {
    const base = (await owner.query<{ id: string; sha256: string }>(
      `SELECT id, sha256 FROM video_assets WHERE workspace_id=$1 AND status <> 'archived' LIMIT 1`,
      [workspaceId])).rows[0]!;
    const stamp = () => isoOf(new Date(Date.now() + 3_600_000));
    const row = (id: string, sha256: string, extra: Record<string, unknown> = {}) => ({
      id, project_id: null, chain_id: id, kind: "clip", version: 1, parent_id: null,
      source_url: "local://push", provenance: {}, license_risk: "none", hero_image_id: null,
      sha256, meta: {}, status: "registered", created_by: "device", created_at: stamp(), updated_at: stamp(),
      title: `推送行 ${id}`, tags: [], prompt: null, pipeline_kind: null, duration_seconds: null,
      width: null, height: null, thumb_path: null, source_type: "generated", sync_state: "cloud_only",
      ...extra,
    });

    const goodId = `VA-push-ok-${suffix}`;
    const result = await mods.applyPush(getAppPool(), scope, {
      assets: [
        row(goodId, `sha-push-ok-${suffix}`),
        // 与既有素材同内容不同 id → 必须降级为冲突（旧实现：唯一索引炸整个请求）
        row(`VA-push-dup-${suffix}`, base.sha256),
        // 违反 CHECK 约束（kind 非法）→ 必须进 failed[] 且不影响其它行
        row(`VA-push-bad-${suffix}`, `sha-push-bad-${suffix}`, { kind: "not_a_kind" }),
      ] as never,
    }, "device-isolation");

    expect(result.applied.assets, "好行必须落库").toBe(1);
    expect(result.conflicts.some((c) => c.table === "assets" && c.reason.includes("sha256"))).toBe(true);
    expect(result.failed.some((f) => f.id === `VA-push-bad-${suffix}`)).toBe(true);
    const stored = await owner.query(`SELECT id FROM video_assets WHERE workspace_id=$1 AND id=$2`, [workspaceId, goodId]);
    expect(stored.rowCount).toBe(1);
    const bad = await owner.query(`SELECT id FROM video_assets WHERE workspace_id=$1 AND id=$2`, [workspaceId, `VA-push-bad-${suffix}`]);
    expect(bad.rowCount, "坏行不得落库").toBe(0);
  }, 90_000);

  /**
   * 路径围栏回归（T-2026-0926-0014 深审实证）：四处入口曾只做字符串拼接/前缀判断，
   * 可把媒体仓外的路径带进业务（甚至把仓外文件复制进媒体仓并可签名下载）。
   */
  it("⑮ 路径围栏：上传 relPath / dossier productId / 交付清单绝对路径 全部拒收", async () => {
    // 1) 上传登记：前缀对但发生路径穿越 → 必须拒
    await expect(mods.registerUploadedAsset(getAppPool(), getGatewayPool(), scope, {
      sha256: "a".repeat(64),
      relPath: `upload/${workspaceId}/../../../etc/passwd`,
      kind: "upload_video",
    }, "vitest")).rejects.toThrow(/越界/);

    // 2) 商品档案：productId 只收单段目录名
    await expect(mods.upsertProductProfileFromDossier(getAppPool(), getGatewayPool(), scope, {
      dossierRoot: join(TMP, "dossiers", workspaceId), productId: "../../../etc", by: "vitest", fetchHero: false,
    })).rejects.toThrow(/productId非法/);

    // 3) 交付清单：manifest 里的绝对路径必须被拒（原实现会把它复制进媒体仓）
    const outside = join(TMP, "outside-⑮");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "SECRET", "utf8");
    const pkg = join(TMP, "delivery-⑮");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "delivery-manifest.json"), JSON.stringify({
      projectId, master: { path: join(outside, "secret.txt"), sha256: "x" }, variants: [],
    }), "utf8");
    await expect(mods.ingestDeliveryPackage(getAppPool(), getGatewayPool(), scope, { dir: pkg, by: "vitest" }))
      .rejects.toThrow(/工作区/);
    const leaked = await owner.query(
      `SELECT id FROM video_assets WHERE workspace_id=$1 AND meta->>'deliveryRole'='master' AND meta->>'deliveryPackage'=$2`,
      [workspaceId, pkg]);
    expect(leaked.rowCount).toBe(0);
  }, 90_000);

  /**
   * 商品档案稳定身份（T-2026-0926-0015）：改名不再新建行；UI 的"单卡重扫"改用目录名。
   */
  it("⑯ 商品档案：改名只更新同一行，且可用 dossier 目录名重扫", async () => {
    const root = join(TMP, "dossiers-16", workspaceId);
    const productId = "PRD-RENAME-1";
    mkdirSync(join(root, productId), { recursive: true });
    const write = (name: string) => writeFileSync(join(root, productId, "dossier.json"), JSON.stringify({
      product_id: productId, identity: { name, brand: "品牌" }, selling_points: ["卖点"],
    }), "utf8");

    write("改名前的商品");
    const first = await mods.upsertProductProfileFromDossier(getAppPool(), getGatewayPool(), scope, {
      dossierRoot: root, productId, by: "vitest", fetchHero: false,
    });
    expect(first.profile.dossierProductId).toBe(productId);

    write("改名后的商品");
    const second = await mods.upsertProductProfileFromDossier(getAppPool(), getGatewayPool(), scope, {
      dossierRoot: root, productId, by: "vitest", fetchHero: false,
    });
    expect(second.profile.id, "改名必须复用同一行").toBe(first.profile.id);
    expect(second.profile.productName).toBe("改名后的商品");
    const rows = await owner.query(`SELECT id, product_name FROM media_product_profiles WHERE workspace_id=$1 AND dossier_product_id=$2`, [workspaceId, productId]);
    expect(rows.rowCount).toBe(1);

    // UI 同款调用：用 dossierProductId（目录名）重扫必须成功
    const third = await mods.upsertProductProfileFromDossier(getAppPool(), getGatewayPool(), scope, {
      dossierRoot: root, productId: second.profile.dossierProductId!, by: "vitest", fetchHero: false,
    });
    expect(third.profile.id).toBe(first.profile.id);
  }, 90_000);

  /**
   * trgm 翻页回归（T-2026-0926-0015）：相似度排序必须配相似度游标。
   * 夹具让"相似度并列最高"的两条分别最旧/最新、低相似度那条在中间 —— 旧实现（created_at 单键游标）
   * 会把中间那条永久跳过。
   */
  it("⑰ trgm 兜底层翻页：相似度游标必须覆盖全部命中（不漏项）", async () => {
    const mkClip = async (name: string, prompt: string) => {
      const file = await writeFixtureFile(`${name}.mp4`, `bytes-${name}`);
      return mods.registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
        absPath: file, kind: "clip", title: name, prompt, by: "vitest", probe: false, thumbnail: false,
      });
    };
    await mkClip("trgm-oldest", "实验室");
    await new Promise((r) => setTimeout(r, 30));
    await mkClip("trgm-middle", "实验室 讲解 结构 产品 演示 现场");
    await new Promise((r) => setTimeout(r, 30));
    await mkClip("trgm-newest", "实验室");

    const full = (await mods.listAssets(getAppPool(), scope, { query: "实验", limit: 200 })).items.map((i) => i.id).sort();
    expect(full.length).toBeGreaterThanOrEqual(3);
    const seen: string[] = [];
    const layers = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 30; guard += 1) {
      const page = await mods.listAssets(getAppPool(), scope, { query: "实验", limit: 2, cursor: cursor ?? undefined });
      if (page.searchTrace?.layer) layers.add(page.searchTrace.layer);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(layers.has("trgm"), `夹具必须落在 trgm 兜底层（实际 ${[...layers].join(",")}）`).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort(), "trgm 翻页并集必须等于检索全量").toEqual(full);
  }, 120_000);

  /**
   * 运维/安全批回归（T-2026-0926-0016）：重剪并发闸 + 临时目录清理 + 配额含孤儿 + 设备过期。
   */
  it("⑱ 重剪并发闸 + 临时目录清理；配额计入未登记上传；设备凭证过期即拒", async () => {
    // 1) 配额：未登记的上传落盘必须计入（旧实现只看已登记 meta.bytes）
    const orphanDir = join(process.env.WORKLOOM_MEDIA_DIR!, "upload", workspaceId);
    mkdirSync(orphanDir, { recursive: true });
    const orphan = join(orphanDir, "orphan-⑱.mp4");
    writeFileSync(orphan, Buffer.alloc(2 * 1024 * 1024, 3));
    const tight = await mods.checkUploadQuota(getAppPool(), scope, 1024, { WORKLOOM_MEDIA_QUOTA_GB: "0.001" });
    expect(tight.ok, "孤儿占盘必须参与配额判定").toBe(false);
    // TTL 按 mtime 判定：把孤儿"变旧"再清理（新文件不该被误删）
    const past = new Date(Date.now() - 7_200_000);
    utimesSync(orphan, past, past);
    const cleanup = mods.cleanupStaleUploads(workspaceId, { MEDIA_ORPHAN_TTL_HOURS: "1" });
    expect(cleanup.removed).toBeGreaterThan(0);
    expect(existsSync(orphan)).toBe(false);

    // 2) 设备凭证过期即拒
    const device = await mods.enrollDevice(getAppPool(), scope, { label: "过期设备", by: "MEM-T" });
    await owner.query(`UPDATE media_sync_devices SET expires_at = now() - interval '1 day' WHERE id = $1`, [device.deviceId]);
    const key = mods.deviceKeyFor(device.deviceId);
    const timestamp = String(Date.now());
    const bodyText = "";
    const verdict = await mods.verifyDeviceRequest(owner, {
      deviceId: device.deviceId, timestamp,
      signature: mods.deviceSignature({ method: "GET", path: "/sync/media/pull", timestamp, bodySha256: mods.bodyHash(bodyText) }, key),
      method: "GET", path: "/sync/media/pull", body: bodyText,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("DEVICE_EXPIRED");
  }, 90_000);

  /**
   * 质量跟进回归（T-2026-0926-0017）：向量回填不得推进 updated_at（否则每轮回填制造"全库变更"）。
   */
  it("⑲ 向量回填不推进 updated_at（skip_media_touch 豁免生效）", async () => {
    const file = await writeFixtureFile("embed-probe.mp4", "embed-bytes");
    const clip = await mods.registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
      absPath: file, kind: "clip", title: "回填素材", prompt: "回填实验室探针", by: "vitest", probe: false, thumbnail: false,
    });
    const before = (await owner.query<{ updated_at: string }>(`SELECT updated_at::text AS updated_at FROM video_assets WHERE id=$1`, [clip.assetId])).rows[0]!.updated_at;
    // batch/max 必须覆盖整个工作区（回填按 created_at ASC 取批，只跑 5 条时新素材排不进批）
    const result = await mods.backfillEmbeddings(getAppPool(), scope, { batch: 200, max: 1000, env: {} });
    expect(result.embedded + result.skipped).toBeGreaterThan(0);
    const after = (await owner.query<{ updated_at: string; has_embedding: boolean }>(
      `SELECT updated_at::text AS updated_at, (embedding IS NOT NULL) AS has_embedding FROM video_assets WHERE id=$1`, [clip.assetId])).rows[0]!;
    expect(after.has_embedding, "回填必须真的写入向量").toBe(true);
    expect(after.updated_at, "回填不得推进 updated_at").toBe(before);
  }, 90_000);

  /**
   * 存在性检查批量化回归（T-2026-0926-0019）：列表的 hasLocalFile/thumbUrl 必须仍然反映磁盘事实
   * （改为每请求一次 readdir 建集合后，不允许出现"索引与磁盘不一致"）。
   */
  it("㉑ 列表存在性：文件在盘=true，删档后=false（索引口径与磁盘一致）", async () => {
    const file = await writeFixtureFile("exists-probe.mp4", "exists-bytes");
    const clip = await mods.registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
      absPath: file, kind: "clip", title: "存在性素材", prompt: "存在性探针", by: "vitest", probe: false, thumbnail: false,
    });
    const row = (await owner.query<{ local_path: string }>(`SELECT meta->>'localPath' AS local_path FROM video_assets WHERE id=$1`, [clip.assetId])).rows[0]!;
    const before = (await mods.listAssets(getAppPool(), scope, { limit: 200 })).items.find((item) => item.id === clip.assetId);
    expect(before?.hasLocalFile).toBe(true);
    rmSync(join(process.env.WORKLOOM_MEDIA_DIR!, row.local_path), { force: true });
    const after = (await mods.listAssets(getAppPool(), scope, { limit: 200 })).items.find((item) => item.id === clip.assetId);
    expect(after?.hasLocalFile).toBe(false);
    expect(after?.thumbUrl ?? null, "无缩略图时不得给出签名缩略图地址").toBeNull();
  }, 90_000);

  it.runIf(hasFfmpeg)("⑪ 重剪：真实 ffmpeg 归一化拼接 → 新 final_cut（source_type=recut）", async () => {
    const a = await makeTinyClip("recut-a.mp4", "red");
    const b = await makeTinyClip("recut-b.mp4", "blue");
    const clipA = await mods.registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
      absPath: a, kind: "clip", title: "重剪素材 A", prompt: "红色画面", by: "vitest", thumbnail: false,
    });
    const clipB = await mods.registerLocalAsset(getAppPool(), getGatewayPool(), scope, {
      absPath: b, kind: "clip", title: "重剪素材 B", prompt: "蓝色画面", by: "vitest", thumbnail: false,
    });
    const collection = await mods.createCollection(getAppPool(), scope, { title: "重剪契约片单", by: "MEM-T" });
    await mods.addCollectionItem(getAppPool(), scope, { collectionId: collection.id, assetId: clipA.assetId, by: "MEM-T" });
    await mods.addCollectionItem(getAppPool(), scope, { collectionId: collection.id, assetId: clipB.assetId, by: "MEM-T" });
    const started = await mods.startRecut(getAppPool(), getGatewayPool(), scope, {
      collectionId: collection.id, title: "重剪契约成片", by: "MEM-T",
    });
    expect(started.segments).toBe(2);
    const deadline = Date.now() + 120_000;
    let job = mods.recutJob(started.jobId);
    while (job && job.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      job = mods.recutJob(started.jobId);
    }
    expect(job?.status, job?.error ?? "").toBe("done");
    expect(job?.producedAssetId).toBeTruthy();
    const produced = await owner.query(
      `SELECT kind, source_type, provenance->'fromAssets' AS from_assets, provenance->>'collectionId' AS collection_id,
              duration_seconds
         FROM video_assets WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, job?.producedAssetId]);
    expect(produced.rows[0].kind).toBe("final_cut");
    expect(produced.rows[0].source_type).toBe("recut");
    expect(produced.rows[0].collection_id).toBe(collection.id);
    expect((produced.rows[0].from_assets as string[]).length).toBe(2);
    const collectionAfter = await mods.getCollection(getAppPool(), scope, collection.id);
    expect(collectionAfter?.collection.status).toBe("used");
  }, 180_000);
});
