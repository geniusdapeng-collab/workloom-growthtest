/** A single intent, real receipts and local feedback. Public inputs never include paths or gate verdicts. */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { newId } from "@workloom/shared";
import { DIRECTOR_POLICY_VERSION, resolveDeliveryTargets, attributeCreativeFeedback } from "@hyperreality/video-studio";
import { actionProcedure, navigationPermissionProcedure, navigationPermissionWriteProcedure, router, scopeOf } from "../trpc/context.js";
import { directorTx, readExplicitDirectorPreferences, saveExplicitDirectorPreference } from "./director-store.js";
import { directorEvent, latestDirectorPlan, queueDirectorJob, readDirectorJob, recoverInterruptedDirectorJob, DirectorJobError, type DirectorJob } from "./director-jobs.js";
import { bindOwnDirectorIdentity, publicDirectorVariants, publicDirectorDifference } from "./director-sources.js";
import { resolveAuthoritativeClientAccess } from "../service/access-authority.js";
import { cancelDirectorJob, dispatchDirectorJob } from "./director-worker.js";
import { loadQualifiedRenderInput } from "./production-authority.js";
import { getAppPool } from "@workloom/db";

const read=navigationPermissionProcedure("ai-video.assets.read");
const write=navigationPermissionWriteProcedure("ai-video.assets.read");
const id=z.string().min(1).max(200);
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const directorBlindLabel=z.enum(["A","B","C","D","E","F","G","H","I","J"]);
const options=z.object({platforms:z.array(z.enum(["douyin","xiaohongshu","wechat-channels"])).min(1).max(3).optional(),
  includeSurprise:z.boolean().optional(),versionCount:z.number().int().min(1).max(6).optional(),stylesPerPlatform:z.literal(3).optional()}).strict();
const by=(identity:{memberId:string;memberNo:string})=>identity.memberId||identity.memberNo;

async function api<T>(work:()=>Promise<T>):Promise<T> {
  try{return await work();}catch(error){
    if(error instanceof TRPCError) throw error;
    const code=error instanceof DirectorJobError?error.code:(error instanceof Error?error.message.split(":")[0]:"");
    if(code && /NOT_FOUND/u.test(code)) throw new TRPCError({code:"NOT_FOUND",message:"任务或素材不存在，或不属于当前工作区"});
    if(code && /CONFLICT|BUSY|IDEMPOTENCY/u.test(code)) throw new TRPCError({code:"CONFLICT",message:error instanceof Error?error.message:code});
    if(code && /REQUIRED|INVALID|UNAVAILABLE|UNVERIFIED|CHANGED|EXPIRED|MISMATCH/u.test(code))
      throw new TRPCError({code:"PRECONDITION_FAILED",message:error instanceof Error?error.message:code});
    console.error("[director API]",error instanceof Error?error.name:"unknown error");
    throw new TRPCError({code:"INTERNAL_SERVER_ERROR",message:"导演服务暂时不可用。已保留任务记录，请稍后刷新。"});
  }
}
/** Private paths, provider tokens and input receipts are deliberately absent from the UI contract. */
export function publicDirectorJob(job:DirectorJob) {
  const receipt=job.receipt??{};
  const variants=Array.isArray(receipt.variants)?publicDirectorVariants(receipt.variants as Array<Record<string,unknown>>):[];
  return {id:job.id,projectId:job.project_id,status:job.status,errorCode:job.error_code,createdAt:job.created_at,updatedAt:job.updated_at,
    stage:typeof receipt.stage==="string"?receipt.stage:"任务已排队",message:typeof receipt.message==="string"?receipt.message:null,
    planHash:typeof receipt.planHash==="string"?receipt.planHash:null,planRevision:typeof receipt.planRevision==="number"?receipt.planRevision:null,
    deliveryRevision:typeof receipt.deliveryRevision==="number"?receipt.deliveryRevision:null,
    filmPlan:receipt.filmPlan??null,targetPlan:receipt.targetPlan??null,difference:publicDirectorDifference(receipt.difference),
    requiredInputs:receipt.requiredInputs??[],requiredApproval:receipt.requiredApproval??null,
    estimatedCny:receipt.estimatedCny??null,budgetCny:receipt.budgetCny??null,
    textCalls:receipt.textCalls??null,renderApiCalls:receipt.renderApiCalls??null,imageApiCalls:receipt.imageApiCalls??null,
    mediaReady:receipt.mediaReady===true,ordinaryConfirmations:receipt.ordinaryConfirmations??0,variants};
}

export const directorRouter=router({
  resolveTargets:read.input(z.object({intent:z.string().min(1).max(10000),options:options.optional()}).strict())
    .query(({input})=>api(async()=>resolveDeliveryTargets(input.intent,input.options))),
  start:write.input(z.object({intent:z.string().trim().min(2).max(10000),mode:z.enum(["produce","plan"]).default("produce"),
    deliveryOptions:options.optional(),identityAssetRefs:z.array(id).max(4).optional(),audioMode:z.enum(["source","dubbing"]).default("source"),
    maxBudgetCny:z.number().nonnegative().max(100000).optional(),idempotencyKey:z.string().min(8).max(200)}).strict())
    .mutation(({ctx,input})=>api(async()=>{
      resolveDeliveryTargets(input.intent,input.deliveryOptions);
      const scope=scopeOf(ctx.identity);
      const queued=await queueDirectorJob(scope,{intent:input.intent,by:by(ctx.identity),idempotencyKey:input.idempotencyKey,
        payload:{kind:"create",mode:input.mode,audioMode:input.audioMode,deliveryOptions:input.deliveryOptions??null,
          identityAssetRefs:input.identityAssetRefs??[],maxBudgetCny:input.maxBudgetCny??null}});
      dispatchDirectorJob(scope,queued.job,ctx);return {...publicDirectorJob(queued.job),reused:queued.reused};
    })),
  jobs:read.input(z.object({projectId:id.optional(),limit:z.number().int().min(1).max(50).default(20)}).optional())
    .query(({ctx,input})=>api(()=>directorTx(scopeOf(ctx.identity),async client=>{
      const jobs=(await client.query<DirectorJob>(`SELECT * FROM video_director_jobs WHERE tenant_id=$1 AND workspace_id=$2
        AND ($3::text IS NULL OR project_id=$3) ORDER BY created_at DESC LIMIT $4`,
        [ctx.identity.tenantId,ctx.identity.workspaceId,input?.projectId??null,input?.limit??20])).rows;
      return jobs.map(publicDirectorJob);
    }))),
  job:read.input(z.object({jobId:id}).strict()).query(({ctx,input})=>api(async()=>{
    const scope=scopeOf(ctx.identity),job=await recoverInterruptedDirectorJob(scope,input.jobId);
    if(!job) throw new DirectorJobError("JOB_NOT_FOUND","任务不存在");
    return publicDirectorJob(job);
  })),
  getVersions:read.input(z.object({projectId:id}).strict()).query(({ctx,input})=>api(async()=>{
    const scope=scopeOf(ctx.identity),plan=await latestDirectorPlan(scope,input.projectId);
    if(!plan) throw new DirectorJobError("PLAN_NOT_FOUND","这个项目还没有导演方案");
    const receipt=await directorTx(scope,async client=>(await client.query<{receipt:Record<string,unknown>}>(`SELECT receipt FROM video_director_jobs
      WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND status IN ('complete','partial') AND receipt ? 'variants'
      ORDER BY created_at DESC LIMIT 1`,[scope.tenantId,scope.workspaceId,input.projectId])).rows[0]?.receipt??null);
    return {projectId:input.projectId,planHash:plan.plan_hash,revision:plan.revision,filmPlan:plan.film_plan,
      targetPlan:plan.target_plan,difference:publicDirectorDifference(receipt?.difference),mediaReady:receipt?.mediaReady===true,
      variants:publicDirectorVariants((receipt?.variants??[]) as Array<Record<string,unknown>>)};
  })),
  renderVariants:write.input(z.object({projectId:id,expectedPlanHash:hash,revision:z.number().int().positive(),
    sourceRefs:z.array(z.object({shotId:id,assetId:id}).strict()).min(1).max(12).optional(),
    identityAssetRefs:z.array(id).max(4).optional(),maxBudgetCny:z.number().positive().max(100000).optional(),audioMode:z.enum(["source","dubbing"]).default("source"),
    idempotencyKey:z.string().min(8).max(200)}).strict()).mutation(({ctx,input})=>api(async()=>{
      const scope=scopeOf(ctx.identity),queued=await queueDirectorJob(scope,{projectId:input.projectId,revision:input.revision,
        expectedPlanHash:input.expectedPlanHash,idempotencyKey:input.idempotencyKey,by:by(ctx.identity),
        payload:{kind:"render",audioMode:input.audioMode,expectedPlanHash:input.expectedPlanHash,sourceRefs:input.sourceRefs??null,
          identityAssetRefs:input.identityAssetRefs??[],maxBudgetCny:input.maxBudgetCny??null}});
      dispatchDirectorJob(scope,queued.job,ctx);return publicDirectorJob(queued.job);
    })),
  feedback:write.input(z.object({projectId:id,expectedPlanHash:hash,revision:z.number().int().positive(),variantId:id.optional(),
    feedback:z.string().trim().min(1).max(10000),idempotencyKey:z.string().min(8).max(200)}).strict())
    .mutation(({ctx,input})=>api(async()=>{
      const scope=scopeOf(ctx.identity),queued=await queueDirectorJob(scope,{projectId:input.projectId,revision:input.revision,
        expectedPlanHash:input.expectedPlanHash,idempotencyKey:input.idempotencyKey,by:by(ctx.identity),
        payload:{kind:"revise",expectedPlanHash:input.expectedPlanHash,feedback:input.feedback,variantId:input.variantId??null}});
      dispatchDirectorJob(scope,queued.job,ctx);return {...publicDirectorJob(queued.job),attribution:attributeCreativeFeedback(input.feedback,{variantId:input.variantId})};
    })),
  cancel:write.input(z.object({jobId:id}).strict()).mutation(({ctx,input})=>api(()=>cancelDirectorJob(scopeOf(ctx.identity),input.jobId))),
  authorizeIdentity:write.input(z.object({assetId:id,selfConsent:z.literal(true)}).strict())
    .mutation(({ctx,input})=>api(()=>bindOwnDirectorIdentity(scopeOf(ctx.identity),input.assetId,by(ctx.identity)))),
  /** One human budget decision covers the exact immutable batch, never future revisions. */
  approveBudget:actionProcedure("approval.decide").use(async({ctx,next})=>{
    const access=await resolveAuthoritativeClientAccess(ctx.identity);
    if(!access.navigationPermissions.includes("ai-video.assets.read")) throw new TRPCError({code:"FORBIDDEN",message:"当前工作区未授予视频制作权限"});
    return next();
  }).input(z.object({jobId:id,approve:z.literal(true),
    expectedPlanHash:hash,idempotencyKey:z.string().min(8).max(200)}).strict()).mutation(({ctx,input})=>api(async()=>{
      const scope=scopeOf(ctx.identity),job=await readDirectorJob(scope,input.jobId);
      if(!job || job.status!=="requires-generation-plan" || job.receipt?.requiredApproval!=="G8"
        || job.receipt.planHash!==input.expectedPlanHash) throw new DirectorJobError("BUDGET_BATCH_INVALID","预算请求不是当前冻结镜头批次");
      const refs=job.receipt.qualifiedShots;
      if(!Array.isArray(refs)||!refs.length) throw new DirectorJobError("BUDGET_BATCH_INVALID","没有完整已评审请求");
      const qualified=await Promise.all(refs.map(ref=>loadQualifiedRenderInput(getAppPool(),scope,String(ref.qualificationToken))));
      const plan=await latestDirectorPlan(scope,job.project_id);
      if(!plan) throw new DirectorJobError("PLAN_NOT_FOUND","导演方案不存在");
      const queued=await queueDirectorJob(scope,{projectId:job.project_id,revision:plan.revision,expectedPlanHash:input.expectedPlanHash,
        idempotencyKey:input.idempotencyKey,by:by(ctx.identity),payload:{...job.payload,kind:"render",expectedPlanHash:input.expectedPlanHash}},
        {beforeInsert:async client=>{
        for(const item of qualified){
          if(item.script.project_id!==job.project_id) throw new DirectorJobError("BUDGET_BATCH_INVALID","脚本归属不一致");
          const script=(await client.query<{status:string;script_key:string;version:number}>(`SELECT status,script_key,version FROM render_scripts
            WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,[scope.workspaceId,job.project_id,item.script.id])).rows[0];
          if(!script) throw new DirectorJobError("BUDGET_BATCH_INVALID","正式脚本不存在");
          if(script.status!=="draft") {if(["approved","submitted","rendering","done"].includes(script.status)) continue;
            throw new DirectorJobError("BUDGET_BATCH_INVALID","已失败的脚本不能继续审批");}
          const event=await directorEvent(client,scope,job.project_id,"video.director.budget.approved",{
            jobId:job.id,planHash:input.expectedPlanHash,scriptId:item.script.id,scriptKey:script.script_key,version:script.version,
            requestHash:item.requestHash,budgetCny:job.receipt?.budgetCny,estimatedCny:job.receipt?.estimatedCny},
            {id:by(ctx.identity),type:"human"});
          await client.query("UPDATE render_scripts SET status='approved',approved_event_id=$4 WHERE workspace_id=$1 AND id=$2 AND version=$3",
            [scope.workspaceId,item.script.id,script.version,event.eventId]);
          await client.query(`INSERT INTO approvals(approval_id,tenant_id,workspace_id,event_id,channel,status,snapshot,decided_by,decided_at)
            VALUES($1,$2,$3,$4,'inapp','approved',$5,$6,now())`,[`apr-${event.eventId.toLowerCase()}`,scope.tenantId,scope.workspaceId,event.eventId,
            {kind:"render_script",scriptId:item.script.id,scriptKey:script.script_key,version:script.version,after:{md:item.script.md,fields:item.script.fields}},by(ctx.identity)]);
        }
      }});
      dispatchDirectorJob(scope,queued.job,ctx);return publicDirectorJob(queued.job);
    })),
  preferences:read.query(({ctx})=>api(()=>readExplicitDirectorPreferences(scopeOf(ctx.identity),by(ctx.identity)))),
  choose:write.input(z.object({projectId:id,expectedPlanHash:hash,revision:z.number().int().positive(),variantId:id,
    score:z.number().int().min(1).max(5).optional(),blindLabel:directorBlindLabel.optional(),
    feedback:z.string().trim().max(10000).optional()}).strict()).mutation(({ctx,input})=>api(async()=>{
      const scope=scopeOf(ctx.identity),plan=await latestDirectorPlan(scope,input.projectId);
      if(!plan || plan.plan_hash!==input.expectedPlanHash || plan.revision!==input.revision) throw new DirectorJobError("REVISION_CONFLICT","版本变化，请刷新后选择");
      if(!plan.target_plan.targets.some(t=>t.variantId===input.variantId)) throw new DirectorJobError("VARIANT_NOT_FOUND","这个版本不属于当前作品");
      const choiceId=await directorTx(scope,async client=>{
        const id=newId("DCH"),event=await directorEvent(client,scope,input.projectId,"video.director.choice",{...input,recipeVersion:DIRECTOR_POLICY_VERSION},
          {id:by(ctx.identity),type:"human"});
        await client.query(`INSERT INTO video_director_choices(id,tenant_id,workspace_id,project_id,revision,variant_id,recipe_version,plan_hash,score,blind_label,feedback,source_event_id,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,scope.tenantId,scope.workspaceId,input.projectId,input.revision,input.variantId,
          DIRECTOR_POLICY_VERSION,input.expectedPlanHash,input.score??null,input.blindLabel??null,input.feedback??null,event.eventId,by(ctx.identity)]);return id;
      });
      if(input.feedback) await saveExplicitDirectorPreference(scope,{projectId:input.projectId,subjectId:by(ctx.identity),feedback:input.feedback,
        attribution:attributeCreativeFeedback(input.feedback,{variantId:input.variantId}),by:by(ctx.identity)});
      return {choiceId,recorded:true,origin:"explicit" as const};
    })),
  calibration:read.query(({ctx})=>api(()=>directorTx(scopeOf(ctx.identity),async client=>{
    const rows=(await client.query<{recipe_version:string;variant_id:string;choices:string;rated:string;average:string|null;blind_choices:string}>(`SELECT recipe_version,variant_id,
      count(*)::text AS choices,count(score)::text AS rated,avg(score)::text AS average,count(blind_label)::text AS blind_choices
      FROM video_director_choices WHERE tenant_id=$1 AND workspace_id=$2 GROUP BY recipe_version,variant_id ORDER BY recipe_version,variant_id`,
      [ctx.identity.tenantId,ctx.identity.workspaceId])).rows;
    return {scope:"current-workspace" as const,qualityImprovement:"unverified" as const,
      rows:rows.map(r=>({recipeVersion:r.recipe_version,variantId:r.variant_id,choices:Number(r.choices),rated:Number(r.rated),
        average:r.average===null?null:Number(r.average),blindChoices:Number(r.blind_choices),sampleNote:Number(r.choices)<30?"样本不足，不据此声称质量提升":"偏好记录，不能替代对照实验"}))};
  }))),
});
