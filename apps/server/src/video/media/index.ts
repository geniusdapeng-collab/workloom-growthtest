/**
 * media/index.ts —— 媒资库 tRPC 子路由（T-2026-0926-0007/0008/0009/0010）
 *
 * 过程清单（规格书 §4.2）：
 *   list / get / updateMeta / archive / tagGroups / createTag / films / quota
 *   uploadTicket / registerUpload
 *   collections.list / create / get / addItem / removeItem / reorder
 *   products.list / get / refresh
 *   findReusable / recut / recutJob / ingestDelivery
 *   sync.status / devices / enroll / revoke / log
 *
 * 守卫口径（实现期评审 R4）：
 *   - 读：`navigationPermissionProcedure("ai-video.media.read")` —— 没有该导航权限的成员
 *     连 API 都调不通（客户端隐藏入口不是授权边界）；
 *   - 写：`navigationPermissionWriteProcedure("ai-video.media.read")` —— 导航读权限 + `workspace.write`
 *     动作权限双守卫。规格书原稿还要求 `ai-video.media.write`，但导航权限全集只能由**导航槽位**重建
 *     （packages/base/bundles/assembly.ts:1084 + service/active-bundle.ts 的闭包校验），
 *     没有槽位承载的 `.write` 权限在运行时恒不在 universe 内 → 用它守卫会让所有写操作 403。
 */
import { z } from "zod";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { getAppPool, getGatewayPool } from "@workloom/db";
import type { Identity } from "@workloom/base/tenancy";
import { navigationPermissionProcedure, navigationPermissionWriteProcedure, scopeOf, router } from "../../trpc/context.js";
import { archiveWorkDir } from "../archive-host.js";
import type { Scope } from "../gen/db.js";
import {
  archiveAsset, createTag, getAsset, ingestPortraitsFromIndex, listAssets, listFilms,
  mediaUsageBytes, tagGroups, updateAssetMeta,
} from "./library.js";
import { checkUploadQuota, registerUploadedAsset, signUploadTicket, uploadMaxBytes } from "./upload.js";
import {
  addCollectionItem, createCollection, getCollection, listCollections, removeCollectionItem, reorderCollection,
} from "./collections.js";
import { getProductProfile, listDossierProductIds, listProductProfiles, upsertProductProfileFromDossier } from "./products.js";
import { findReusable } from "./reuse.js";
import { listRecutJobs, recutJob, startRecut } from "./recut.js";
import { ingestDeliveryPackage, assertSafePackageName } from "./ingest-delivery.js";
import { DeliveryError } from "../delivery-trust.js";
import {
  changesSince, enrollDevice, listDevices, listSyncLog, revokeDevice, syncEnabled,
} from "./sync.js";

const MEDIA_READ = "ai-video.media.read";

const readProcedure = navigationPermissionProcedure(MEDIA_READ);
const writeProcedure = navigationPermissionWriteProcedure(MEDIA_READ);

/** 领域错误 → tRPC 错误码（缺参/非法状态 400，找不到 404，其余 500） */
function mapError(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof DeliveryError) {
    const code = err.code === "not_found" ? "NOT_FOUND"
      : err.code === "scope_mismatch" || err.code === "path_not_allowed" ? "FORBIDDEN"
        : err.code === "delivery_unverified" || err.code === "artifact_changed" ? "PRECONDITION_FAILED"
          : "BAD_REQUEST";
    throw new TRPCError({ code, message: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/不在当前工作区|非法|至少|不一致|必须/.test(message)) {
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
  if (/不存在|缺失/.test(message)) {
    throw new TRPCError({ code: "NOT_FOUND", message });
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
}

const collectBy = (ctx: { identity: Identity }): { scope: Scope; by: string } => {
  const identity = ctx.identity;
  return { scope: scopeOf(identity), by: identity.memberId || identity.name || "media-ui" };
};

const assetKindEnum = z.enum([
  "product_image", "reference_image", "portrait", "clip", "final_cut",
  "shot_plate", "cover", "upload_video", "upload_image", "upload_audio",
]);

export const mediaRouter = router({
  /** 列表（三层检索 + 结构化过滤 + 游标分页） */
  list: readProcedure
    .input(z.object({
      kind: z.array(assetKindEnum).max(10).optional(),
      pipelineKind: z.enum(["narrative", "marketing"]).optional(),
      sourceType: z.enum(["generated", "uploaded", "imported", "recut"]).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      collectionId: z.string().min(1).max(64).optional(),
      projectId: z.string().min(1).max(64).optional(),
      status: z.enum(["active", "archived", "all"]).default("active"),
      query: z.string().max(200).optional(),
      cursor: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(60),
    }).optional())
    .query(async ({ ctx, input }) => {
      const { scope } = collectBy(ctx);
      return listAssets(getAppPool(), scope, input ?? {});
    }),

  /** 详情（版本链 + 关联项目 + 制片档案回链） */
  get: readProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const { scope } = collectBy(ctx);
      const detail = await getAsset(getAppPool(), scope, input.id);
      if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: `素材 ${input.id} 不在当前工作区` });
      return detail;
    }),

  updateMeta: writeProcedure
    .input(z.object({
      id: z.string().min(1).max(64),
      title: z.string().max(200).nullable().optional(),
      tags: z.array(z.string().min(1).max(40)).max(20).optional(),
      prompt: z.string().max(4000).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { scope, by } = collectBy(ctx);
      try {
        return await updateAssetMeta(getAppPool(), scope, {
          assetId: input.id, title: input.title, tags: input.tags, prompt: input.prompt, by,
        });
      } catch (err) {
        mapError(err);
      }
    }),

  archive: writeProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const { scope, by } = collectBy(ctx);
      try {
        await archiveAsset(getAppPool(), scope, { assetId: input.id, by });
        return { ok: true };
      } catch (err) {
        mapError(err);
      }
    }),

  tagGroups: readProcedure.query(async ({ ctx }) => {
    const { scope } = collectBy(ctx);
    return { groups: await tagGroups(getAppPool(), scope) };
  }),

  createTag: writeProcedure
    .input(z.object({ name: z.string().min(1).max(40), group: z.string().max(40).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { scope, by } = collectBy(ctx);
      try {
        return await createTag(getAppPool(), scope, { name: input.name, group: input.group, by });
      } catch (err) {
        mapError(err);
      }
    }),

  /** 成片历史（final_cut 时间线 + 发布状态） */
  films: readProcedure
    .input(z.object({
      cursor: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(40),
      projectId: z.string().min(1).max(64).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const { scope } = collectBy(ctx);
      return listFilms(getAppPool(), scope, input ?? {});
    }),

  /** 配额与占用（上传闸的依据；UI 顶部提示用） */
  quota: readProcedure.query(async ({ ctx }) => {
    const { scope } = collectBy(ctx);
    const usedBytes = await mediaUsageBytes(getAppPool(), scope);
    const maxBytes = uploadMaxBytes();
    const gb = Number(process.env.WORKLOOM_MEDIA_QUOTA_GB ?? 20);
    const quotaBytes = (Number.isFinite(gb) && gb > 0 ? gb : 20) * 1024 ** 3;
    return { usedBytes, quotaBytes, uploadMaxBytes: maxBytes, usageRatio: quotaBytes > 0 ? usedBytes / quotaBytes : 0 };
  }),

  /** 上传凭证（10 分钟有效；配额闸前置） */
  uploadTicket: writeProcedure
    .input(z.object({
      filename: z.string().min(1).max(200),
      bytes: z.number().int().min(1).max(1024 ** 3),
      kind: z.enum(["upload_video", "upload_image", "upload_audio", "reference_image", "product_image"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { scope } = collectBy(ctx);
      const maxBytes = uploadMaxBytes();
      if (input.bytes > maxBytes) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `单文件超过上限（${(input.bytes / 1024 ** 2).toFixed(1)}MB > ${(maxBytes / 1024 ** 2).toFixed(0)}MB）`,
        });
      }
      const verdict = await checkUploadQuota(getAppPool(), scope, input.bytes);
      if (!verdict.ok) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: verdict.reason ?? "媒资配额不足" });
      }
      const ticket = signUploadTicket({ workspaceId: scope.workspaceId, filename: input.filename, maxBytes });
      return {
        uploadUrl: `/media/upload?token=${ticket.token}`,
        token: ticket.token,
        expiresAt: ticket.expiresAt,
        maxBytes,
        usedBytes: verdict.usedBytes,
        quotaBytes: verdict.quotaBytes,
      };
    }),

  /** 登记上传件（复核路径归属 + 实算 sha256） */
  registerUpload: writeProcedure
    .input(z.object({
      sha256: z.string().length(64),
      relPath: z.string().min(1).max(300),
      kind: z.enum(["upload_video", "upload_image", "upload_audio", "reference_image", "product_image"]),
      title: z.string().max(200).nullable().optional(),
      tags: z.array(z.string().min(1).max(40)).max(20).default([]),
      productName: z.string().max(200).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { scope, by } = collectBy(ctx);
      try {
        return await registerUploadedAsset(getAppPool(), getGatewayPool(), scope, input, by);
      } catch (err) {
        mapError(err);
      }
    }),

  /* ---------------- 合集 / 片单 ---------------- */
  collections: router({
    list: readProcedure
      .input(z.object({ status: z.enum(["open", "used", "archived", "all"]).default("all") }).optional())
      .query(async ({ ctx, input }) => ({
        items: await listCollections(getAppPool(), collectBy(ctx).scope, input ?? {}),
      })),

    get: readProcedure
      .input(z.object({ id: z.string().min(1).max(64) }))
      .query(async ({ ctx, input }) => {
        const result = await getCollection(getAppPool(), collectBy(ctx).scope, input.id);
        if (!result) throw new TRPCError({ code: "NOT_FOUND", message: `合集 ${input.id} 不在当前工作区` });
        return result;
      }),

    create: writeProcedure
      .input(z.object({
        title: z.string().min(1).max(120),
        purpose: z.enum(["recut", "favorite", "campaign", "archive"]).default("recut"),
        meta: z.record(z.string(), z.unknown()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { scope, by } = collectBy(ctx);
        try {
          return await createCollection(getAppPool(), scope, { ...input, by });
        } catch (err) {
          mapError(err);
        }
      }),

    addItem: writeProcedure
      .input(z.object({
        collectionId: z.string().min(1).max(64),
        assetId: z.string().min(1).max(64),
        note: z.string().max(500).nullable().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { scope, by } = collectBy(ctx);
        try {
          return await addCollectionItem(getAppPool(), scope, { ...input, by });
        } catch (err) {
          mapError(err);
        }
      }),

    removeItem: writeProcedure
      .input(z.object({ collectionId: z.string().min(1).max(64), assetId: z.string().min(1).max(64) }))
      .mutation(async ({ ctx, input }) => {
        const { scope, by } = collectBy(ctx);
        try {
          return await removeCollectionItem(getAppPool(), scope, { ...input, by });
        } catch (err) {
          mapError(err);
        }
      }),

    reorder: writeProcedure
      .input(z.object({
        collectionId: z.string().min(1).max(64),
        orderedAssetIds: z.array(z.string().min(1).max(64)).min(1).max(200),
      }))
      .mutation(async ({ ctx, input }) => {
        const { scope, by } = collectBy(ctx);
        try {
          return await reorderCollection(getAppPool(), scope, { ...input, by });
        } catch (err) {
          mapError(err);
        }
      }),
  }),

  /* ---------------- 商品档案 ---------------- */
  products: router({
    list: readProcedure.query(async ({ ctx }) => ({
      items: await listProductProfiles(getAppPool(), collectBy(ctx).scope),
    })),

    get: readProcedure
      .input(z.object({ id: z.string().min(1).max(64) }))
      .query(async ({ ctx, input }) => {
        const profile = await getProductProfile(getAppPool(), collectBy(ctx).scope, input.id);
        if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: `商品档案 ${input.id} 不在当前工作区` });
        return profile;
      }),

    /** 重扫 dossier（sha256 对账）：不传 productId 时扫描该工作区全部档案 */
    refresh: writeProcedure
      .input(z.object({ productId: z.string().min(1).max(120).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { scope, by } = collectBy(ctx);
        const dossierRoot = joinDossierRoot(scope);
        const ids = input.productId ? [input.productId] : listDossierProductIds(dossierRoot);
        const results: Array<{ productId: string; ok: boolean; changed?: boolean; error?: string }> = [];
        for (const productId of ids) {
          try {
            const r = await upsertProductProfileFromDossier(getAppPool(), getGatewayPool(), scope, {
              dossierRoot, productId, by,
            });
            results.push({ productId, ok: true, changed: r.changed });
          } catch (err) {
            results.push({ productId, ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return { scanned: ids.length, results };
      }),
  }),

  /* ---------------- 复用 / 重剪 / 交付包补录 ---------------- */
  findReusable: readProcedure
    .input(z.object({
      prompt: z.string().min(2).max(2000),
      durationSec: z.number().min(0).max(600).nullable().optional(),
      aspectRatio: z.string().max(16).nullable().optional(),
      tags: z.array(z.string().max(40)).max(10).optional(),
      projectId: z.string().max(64).nullable().optional(),
      limit: z.number().int().min(1).max(20).default(5),
    }))
    .query(async ({ ctx, input }) => {
      const { scope } = collectBy(ctx);
      const items = await findReusable(getAppPool(), scope, input);
      return { items, count: items.length };
    }),

  recut: writeProcedure
    .input(z.object({
      collectionId: z.string().min(1).max(64),
      title: z.string().min(1).max(120),
    }))
    .mutation(async ({ ctx, input }) => {
      const { scope, by } = collectBy(ctx);
      try {
        return await startRecut(getAppPool(), getGatewayPool(), scope, { ...input, by });
      } catch (err) {
        mapError(err);
      }
    }),

  recutJob: readProcedure
    .input(z.object({ jobId: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      const job = recutJob(input.jobId);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: `重剪作业 ${input.jobId} 不在本进程（重启后作业状态不保留，产出可在成片历史查看）` });
      return job;
    }),

  recutJobs: readProcedure.query(async () => ({ items: listRecutJobs() })),

  /** 交付包补录（规格书 §3.3 的真实落盘点：post-bridge 产出的交付包 → final_cut/cover） */
  ingestDelivery: writeProcedure
    .input(z.object({ dir: z.string().min(1).max(120).optional(), packageName: z.string().min(1).max(120).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { scope, by } = collectBy(ctx);
      const name = input.dir ?? input.packageName;
      if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "需要 dir（交付包目录名或相对路径）" });
      // 深审修正：原实现"含 / 就整体放行"，等于把 dir 变成任意路径读取入口（assertSafePackageName 被短路）
      try {
        const abs = assertSafePackageName(name, scope);
        return await ingestDeliveryPackage(getAppPool(), getGatewayPool(), scope, { dir: abs, by });
      } catch (err) {
        mapError(err);
      }
    }),

  /** 定妆照补录（studio-worker 收尾已自动调用；此处供历史项目补跑） */
  ingestPortraits: writeProcedure
    .input(z.object({
      projectId: z.string().min(1).max(64),
      pipelineKind: z.enum(["narrative", "marketing"]).default("narrative"),
    }))
    .mutation(async ({ ctx, input }) => {
      const { scope, by } = collectBy(ctx);
      const indexPath = join(archiveWorkDir(), "characters", input.projectId, "portrait-index.json");
      return ingestPortraitsFromIndex(getAppPool(), getGatewayPool(), scope, {
        projectId: input.projectId, pipelineKind: input.pipelineKind, indexPath, by,
      });
    }),

  /* ---------------- 云端同步（T-2026-0926-0009） ---------------- */
  sync: router({
    status: readProcedure.query(async ({ ctx }) => {
      const { scope } = collectBy(ctx);
      return {
        enabled: syncEnabled(),
        devices: await listDevices(getAppPool(), scope),
        log: (await listSyncLog(getAppPool(), scope, 50)).entries,
      };
    }),

    devices: readProcedure.query(async ({ ctx }) => ({
      devices: await listDevices(getAppPool(), collectBy(ctx).scope),
    })),

    log: readProcedure
      .input(z.object({
        limit: z.number().int().min(1).max(500).default(100),
        cursor: z.string().max(32).optional(),
      }).optional())
      .query(async ({ ctx, input }) => listSyncLog(
        getAppPool(), collectBy(ctx).scope, input?.limit ?? 100, input?.cursor)),

    enroll: writeProcedure
      .input(z.object({ label: z.string().min(1).max(80) }))
      .mutation(async ({ ctx, input }) => {
        // 设备凭证是长期凭证（默认 90 天）：只允许 owner/manager 签发（深审：staff 也有 workspace.write）
        if (ctx.identity.role !== "owner" && ctx.identity.role !== "manager") {
          throw new TRPCError({ code: "FORBIDDEN", message: "只有工作区所有者/管理员可以签发设备凭证" });
        }
        const { scope, by } = collectBy(ctx);
        try {
          return await enrollDevice(getAppPool(), scope, { label: input.label, by });
        } catch (err) {
          mapError(err);
        }
      }),

    revoke: writeProcedure
      .input(z.object({ deviceId: z.string().min(1).max(64) }))
      .mutation(async ({ ctx, input }) => {
        const { scope } = collectBy(ctx);
        return revokeDevice(getAppPool(), scope, input.deviceId);
      }),

    /** 增量变更预览（云端实例上给设备用的同一函数，UI 侧用于对账巡检） */
    changes: readProcedure
      .input(z.object({ since: z.string().datetime().optional(), limit: z.number().int().min(1).max(1000).default(200) }).optional())
      .query(async ({ ctx, input }) => {
        const { scope } = collectBy(ctx);
        return changesSince(getAppPool(), scope, input ?? {});
      }),
  }),
});

/** dossier 根：与 studio-worker 的 dataMiningConfigFor 同口径（`<WORK_DIR>/dossiers/<ws>`） */
export function joinDossierRoot(scope: Scope): string {
  return join(archiveWorkDir(), "dossiers", scope.workspaceId);
}

/**
 * 交付层返修作业完成 → 媒资库补录新成片（`delivery.ts` 的完成回调注入点）。
 * 失败只记日志：媒资入库是旁路，不能让交付作业被判失败。
 */
export function deliveryIngestHook(scope: Scope): (info: { dir: string; outDir: string | null; version: number | null }) => void {
  return (info) => {
    if ((process.env.MEDIA_INGEST_ENABLED ?? "1") === "0") return;
    void ingestDeliveryPackage(getAppPool(), getGatewayPool(), scope, { dir: info.outDir ?? info.dir, by: "delivery" })
      .then((r) => {
        console.log(`[media] 交付包入库完成：${r.registered.length} 个产物（跳过 ${r.skipped}；错误 ${r.errors.length}）`);
        for (const err of r.errors) console.warn(`[media] 交付包入库告警：${err}`);
      })
      .catch((err) => console.warn(`[media] 交付包入库失败（不影响交付作业）：${err instanceof Error ? err.message : String(err)}`));
  };
}
