/**
 * video/film-router.ts —— 公开 full-chain 入口的服务侧路由（T-2026-0927-0039）。
 *
 * 只有三个动作：登记固定工位、提交一次作业、读作业状态。
 * 公开面**不接受**提示词、门裁定、完成证据或任意路径——那些只存在于服务与工位之间的通道帧，
 * 且每一帧都要在台账先留账。工位不通过这里自报通过。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, scopeOf, writeProcedure } from "../trpc/context.js";
import { SubmissionError } from "./gen/submission-ledger.js";
import { registerFilmWorker, startFilmJob, FILM_WORKER_ENTRY } from "./film-worker.js";
import { FilmLedger } from "./film-ledger.js";
import { getAppPool } from "@workloom/db";

const stages = z.array(z.string().min(1).max(120)).min(1).max(64);
const options = z.record(z.string(), z.unknown());

function asTrpc<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    if (error instanceof SubmissionError) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message, cause: error });
    }
    throw error;
  });
}

export const filmRouter = router({
  /** 登记（或复用）本仓固定影片工位；入口路径在服务侧写死，不接受调用方指定任意路径。 */
  registerWorker: writeProcedure.input(z.object({
    workerName: z.string().min(1).max(120).default("full-chain-film"),
    workerVersion: z.string().min(1).max(120).default("2026-09-28.v1"),
  }).strict()).mutation(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    return asTrpc(async () => {
      const worker = await registerFilmWorker({
        scope,
        actor: ctx.identity.memberNo,
        workerName: input.workerName,
        workerVersion: input.workerVersion,
        entryPath: FILM_WORKER_ENTRY,
      });
      return {
        workerName: worker.worker_name,
        workerVersion: worker.worker_version,
        entryPath: worker.entry_path,
        entrySha256: worker.entry_sha256,
        status: worker.status,
      };
    });
  }),

  /** 提交一条固定工位作业：原稿由服务冻结进项目档案，返回不可换绑的作业回执。 */
  start: writeProcedure.input(z.object({
    projectId: z.string().min(1).max(200),
    workerName: z.string().min(1).max(120).default("full-chain-film"),
    document: z.unknown(),
    stages,
    options: options.default({}),
    maxBudgetCny: z.number().positive().max(100_000).optional(),
  }).strict()).mutation(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    if (!input.document || typeof input.document !== "object" || Array.isArray(input.document)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "document 必须是 JSON 对象" });
    }
    return asTrpc(() => startFilmJob({
      scope,
      actor: ctx.identity.memberNo,
      projectId: input.projectId,
      workerName: input.workerName,
      document: input.document,
      stages: input.stages,
      options: input.options,
      ...(input.maxBudgetCny === undefined ? {} : { maxBudgetCny: input.maxBudgetCny }),
    }));
  }),

  /** 作业状态：作业终态 + 组件台账摘要 + 保守费用合计（预占口径）。 */
  status: protectedProcedure.input(z.object({ jobId: z.string().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const ledger = new FilmLedger(getAppPool(), scope);
      const status = await ledger.jobStatus(input.jobId);
      if (!status) throw new TRPCError({ code: "NOT_FOUND", message: `作业 ${input.jobId} 不存在或不属于当前工作区` });
      return status;
    }),
});
