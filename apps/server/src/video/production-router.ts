/** 外部只能选择服务档案中的镜头；不接受正文、路径、评分或自报通过。 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getAppPool } from "@workloom/db";
import { protectedProcedure, router, scopeOf, writeProcedure } from "../trpc/context.js";
import { listProductionShots, qualifyProductionShot } from "./production-authority.js";
import { SubmissionError } from "./gen/submission-ledger.js";

const params = z.object({
  durationSec: z.number().int().positive().optional(), aspectRatio: z.string().min(1).max(32).optional(),
  resolution: z.string().min(1).max(32).optional(), generateAudio: z.boolean().optional(),
  firstFrameUrl: z.string().min(1).max(8192).optional(),
  referenceImageUrls: z.array(z.string().min(1).max(8192)).max(16).optional(),
  referenceVideoUrls: z.array(z.string().min(1).max(8192)).max(8).optional(),
  referenceAudioUrls: z.array(z.string().min(1).max(8192)).max(8).optional(),
  seed: z.number().int().optional(), negativePrompt: z.string().max(4000).optional(), watermark: z.boolean().optional(),
  cameraFixed: z.boolean().optional(), returnLastFrame: z.boolean().optional(), serviceTier: z.string().max(32).optional(),
  priority: z.number().int().optional(), executionExpiresAfter: z.number().int().positive().optional(),
  frames: z.number().int().positive().optional(), outputFormat: z.string().max(32).optional(),
  callbackUrl: z.url().max(8192).optional(), extra: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const productionRouter = router({
  shots: protectedProcedure.input(z.object({ projectId: z.string().min(1).max(200) }).strict()).query(async ({ ctx, input }) => {
    try { return await listProductionShots({ app: getAppPool(), scope: scopeOf(ctx.identity), projectId: input.projectId }); }
    catch (error) {
      if (error instanceof SubmissionError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message, cause: error });
      throw error;
    }
  }),
  qualifyShot: writeProcedure.input(z.object({
    projectId: z.string().min(1).max(200), shotId: z.string().min(1).max(200), modelId: z.string().min(1).max(200),
    params: params.default({}), mode: z.enum(["manual", "batch", "auto"]).default("manual"),
  }).strict()).mutation(async ({ ctx, input }) => {
    try {
      return await qualifyProductionShot({ app: getAppPool(), scope: scopeOf(ctx.identity), actor: ctx.identity.memberNo, ...input });
    } catch (error) {
      if (error instanceof SubmissionError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message, cause: error });
      throw error;
    }
  }),
});
