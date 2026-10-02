/** One-intent orchestration. All paid generation uses the existing qualified service caller. */
import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { GatewayEventSink, planTierToPlanId } from "@workloom/base/model-router";
import { planDirectorFilm, WorkloomLLMEngine, buildDirectorDefaults, directorHash, type DirectorFilmPlan } from "@hyperreality/video-studio";
import type { TrpcContext } from "../trpc/context.js";
import { modelPolicyFor } from "../service/llm.js";
import { currentMemberAuthority, memberAccessGrants } from "../service/access-authority.js";
import { createDirectorGrantOnClient, directorTx, readExplicitDirectorPreferences, saveExplicitDirectorPreference } from "./director-store.js";
import { acquireDirectorLease, readDirectorJob, updateDirectorJob, freezeDirectorPlan, latestDirectorPlan,
  type DirectorJob, type DirectorJobStatus, DirectorJobError } from "./director-jobs.js";
import { directorWorkRoot, directorConnectors, resolveDirectorIdentities, resolveDirectorAsset, prepareDirectorAudio,
  registerDirectorVariants, preflightDirectorAudio, type SourceClip } from "./director-sources.js";
import { startRun, getRun } from "./studio-worker.js";
import { safeSegment } from "./media/paths.js";
import { sha256File } from "./media/register-local.js";
import { renderSubmitAutoAllowed } from "./gate-policy.js";

const queue:Array<{scope:{tenantId:string;workspaceId:string};job:DirectorJob;context:TrpcContext}>=[];
const controllers=new Map<string,AbortController>();let workers=0;
const workerLimit=2;
const delay=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  if(signal.aborted){reject(new DirectorJobError("DIRECTOR_CANCELLED","制作已停止"));return;}
  const onAbort=()=>{clearTimeout(timer);signal.removeEventListener("abort",onAbort);reject(new DirectorJobError("DIRECTOR_CANCELLED","制作已停止"));};
  const timer=setTimeout(()=>{signal.removeEventListener("abort",onAbort);resolve();},ms);signal.addEventListener("abort",onAbort,{once:true});
});
export function dispatchDirectorJob(scope:{tenantId:string;workspaceId:string},job:DirectorJob,context:TrpcContext) {
  if(job.status!=="queued" || queue.some(item=>item.job.id===job.id)||controllers.has(job.id)) return;
  queue.push({scope,job,context});pump();
}
function pump() {
  while(workers<workerLimit&&queue.length) {
    const next=queue.shift()!;workers++;
    void runDirectorJob(next).catch(error=>console.error(`[director ${next.job.id}] ${safeError(error)}`)).finally(()=>{workers--;pump();});
  }
}
function safeError(error:unknown) {
  let message=error instanceof Error?error.message:String(error);
  for(const [key,value] of Object.entries(process.env)) if(value&&/KEY|SECRET|PASSWORD|TOKEN/u.test(key)&&value.length>8) message=message.split(value).join("[redacted]");
  return message.slice(0,1800);
}
export async function cancelDirectorJob(scope:{tenantId:string;workspaceId:string},id:string) {
  const job=await readDirectorJob(scope,id);if(!job) throw new DirectorJobError("JOB_NOT_FOUND","任务不存在或不属于当前工作区");
  if(!["queued","running"].includes(job.status)) return {status:job.status,changed:false};
  controllers.get(id)?.abort();
  const preproduction = getRun(`DR-${id}`, scope.workspaceId);
  if (preproduction) preproduction.aborted = true;
  await updateDirectorJob(scope,id,"interrupted",{...job.receipt,stage:"已停止",reason:"客户停止制作；已派发的供应商任务需核对，不自动重发"},"DIRECTOR_CANCELLED");
  return {status:"interrupted",changed:true};
}
async function runDirectorJob({scope,job,context}:typeof queue[number]) {
  const abort=new AbortController();
  const lease=await acquireDirectorLease(scope,job.project_id,()=>abort.abort());
  if(!lease) return; // another live host owns the project; it alone can claim the durable row
  controllers.set(job.id,abort);
  const deadlineMs=Date.now()+Math.min(2*60*60_000,Math.max(300_000,Number(process.env.WORKLOOM_DIRECTOR_TIMEOUT_MS??3_600_000)));
  let progress:Record<string,unknown>={stage:"导演正在创作",workerPid:process.pid,mediaReady:false,renderApiCalls:0,imageApiCalls:0};
  const checkpoint=async(stage?:string,extra:Record<string,unknown>={})=>{
    if(abort.signal.aborted) throw new DirectorJobError("DIRECTOR_CANCELLED","任务已取消");
    if(Date.now()>=deadlineMs) throw new DirectorJobError("DIRECTOR_TIMEOUT","制作超时；保留回执，不自动重新提交付费任务");
    if(stage) progress={...progress,stage,...extra};else progress={...progress,...extra};
    await updateDirectorJob(scope,job.id,"running",progress);
  };
  const authority=async()=>{
    if(!context.identity) throw new DirectorJobError("AUTH_REQUIRED","会话已失效");
    const current=await currentMemberAuthority(context.identity);
    const actions=memberAccessGrants({role:current.identity.role,plan:current.identity.plan,guest:current.identity.memberNo==="GUEST",permissions:current.permissions});
    if(!actions.actionPermissions.includes("workspace.write")) throw new DirectorJobError("WRITE_PERMISSION_REVOKED","制作权限已被收回");
    if(current.identity.tenantId!==scope.tenantId || current.identity.workspaceId!==scope.workspaceId) throw new DirectorJobError("SCOPE_MISMATCH","制作会话作用域变化");
    return {...context,session:current.identity,identity:current.identity};
  };
  try {
    const initial=await readDirectorJob(scope,job.id);if(initial?.status!=="queued") return;
    await checkpoint();await authority();
    const payload=job.payload,kind=String(payload.kind??"create");
    let filmPlan:DirectorFilmPlan;
    let frozen=await latestDirectorPlan(scope,job.project_id);
    if(kind==="create") {
      const intent=String(payload.intent??"");
      const identities=await resolveDirectorIdentities(scope,job.created_by,Array.isArray(payload.identityAssetRefs)?payload.identityAssetRefs as string[]:undefined);
      const engine=WorkloomLLMEngine.fromEnv();
      if(!engine || (process.env.LLM_PROVIDER??"mock")==="mock") throw new DirectorJobError("LLM_UNAVAILABLE","请先在设置里连接真实语言模型，系统不会用模板冒充导演制作");
      engine.attachConfiguredRouter({sink:new GatewayEventSink(getGatewayPool(),scope,{id:"video-director"}),
        policy:modelPolicyFor("ai-video"),scene:"briefing",plan:planTierToPlanId(context.identity?.plan??"pro")});
      const history=await readExplicitDirectorPreferences(scope,job.created_by);
      filmPlan=await planDirectorFilm({intent,engine,identityAssetRefs:identities.map(a=>a.id),history:history.map(h=>({origin:"explicit",feedback:h.feedback})),
        allowMissingIdentityForPlan:true,deliveryOptions:(payload.deliveryOptions??undefined) as Parameters<typeof planDirectorFilm>[0]["deliveryOptions"],
        deadlineMs,signal:abort.signal,onProgress:(stage,calls)=>checkpoint(stage,{callReceipts:calls,textCalls:calls.length})});
      const freeze=await freezeDirectorPlan(scope,job.project_id,{filmPlan,revision:job.revision,by:job.created_by});
      progress={...progress,filmPlan,planHash:freeze.planHash,planRevision:freeze.revision,targetPlan:filmPlan.deliveryTargetPlan};
      frozen=await latestDirectorPlan(scope,job.project_id);
      if(payload.mode==="plan") {
        await updateDirectorJob(scope,job.id,"complete",{...progress,stage:"文字创作已完成",mediaReady:false,renderApiCalls:0,imageApiCalls:0,
          ordinaryConfirmations:0,personAesthetics:"not-tested",requiredInputs:filmPlan.directorProfile.requiredInputs});return;
      }
    } else {
      if(!frozen || frozen.film_plan.schemaVersion!=="workloom.director-film-plan/v2") throw new DirectorJobError("PLAN_REQUIRED","没有冻结的导演方案");
      filmPlan=frozen.film_plan;
      if(payload.expectedPlanHash!==frozen.plan_hash) throw new DirectorJobError("REVISION_CONFLICT","作品版本变化，请刷新后操作");
      progress={...progress,filmPlan,planHash:frozen.plan_hash,planRevision:frozen.revision,targetPlan:filmPlan.deliveryTargetPlan};
    }
    const connectors=await directorConnectors({mediaRuntime:kind==="revise"||Array.isArray(payload.sourceRefs)||Number(payload.maxBudgetCny??process.env.WORKLOOM_DIRECTOR_BUDGET_CNY??0)>0});
    const {post,measure,env,bins}=connectors;
    const base=path.join(directorWorkRoot(),safeSegment(scope.workspaceId),safeSegment(job.project_id));await mkdir(base,{recursive:true});
    let result:any,clips:SourceClip[]=[];
    if(kind==="revise") {
      await checkpoint("按意见调整作品");
      const prior=await completedPackage(scope,job.project_id);
      if(!prior?.projectPath || !prior.projectSha256) throw new DirectorJobError("DELIVERY_REQUIRED","还没有可修改的成片");
      const projectFile=path.resolve(String(prior.projectPath));
      if(!projectFile.startsWith(base+path.sep)) throw new DirectorJobError("PACKAGE_SCOPE_MISMATCH","后期工程归属不一致");
      result=await post.reviseDirectorDelivery({projectPath:projectFile,feedback:String(payload.feedback),variantId:payload.variantId??null,
        expectedVersion:prior.deliveryRevision,expectedProjectSha256:prior.projectSha256,idempotencyKey:job.idempotency_key,bins,env});
      if(result.status==="requires-generation-plan") {
        await saveExplicitDirectorPreference(scope,{projectId:job.project_id,subjectId:job.created_by,feedback:String(payload.feedback),attribution:result.attribution,by:job.created_by});
        await updateDirectorJob(scope,job.id,"requires-generation-plan",{...progress,...result,stage:"新增画面需要独立预算授权",mediaReady:false});return;
      }
      await saveExplicitDirectorPreference(scope,{projectId:job.project_id,subjectId:job.created_by,feedback:String(payload.feedback),attribution:result.attribution,by:job.created_by});
    } else {
      const refs=Array.isArray(payload.sourceRefs)?payload.sourceRefs as Array<{shotId:string;assetId:string}>:null;
      if(refs) clips=await loadClips(scope,job.project_id,refs,filmPlan,measure,bins);
      else {
        const budget=Number(payload.maxBudgetCny??process.env.WORKLOOM_DIRECTOR_BUDGET_CNY??0);
        const identities=await resolveDirectorIdentities(scope,job.created_by,Array.isArray(payload.identityAssetRefs)?payload.identityAssetRefs as string[]:undefined);
        const readiness=buildDirectorDefaults({intent:filmPlan.intent,identityAssets:identities.map(a=>a.id)});
        if(readiness.requiredInputs.length || !(budget>0)) {
          await updateDirectorJob(scope,job.id,"requires-generation-plan",{...progress,stage:readiness.requiredInputs.length?"需要一次本人素材":"等待制作预算授权",
            requiredInputs:readiness.requiredInputs,requiredApproval:budget>0?null:"generation-budget",mediaReady:false,renderApiCalls:0,imageApiCalls:0,
            message:readiness.requiredInputs.length?"添加一次本人素材，后续项目自动复用":"文字方案已经完成，设置制作预算后可继续；没有提交图像或视频请求"});return;
        }
        const {videoRouter}=await import("./router.js");
        await checkpoint("检查本机后期和声音工具");
        await preflightDirectorAudio(filmPlan,connectors);
        let caller=videoRouter.createCaller(await authority());
        const catalog=await caller.gen.catalog({kind:"video"});
        const model=catalog.models.find(m=>m.id===process.env.WORKLOOM_VIDEO_DEFAULT_MODEL)??catalog.models.find(m=>m.available);
        if(!model) throw new DirectorJobError("VIDEO_MODEL_UNAVAILABLE","没有可用视频模型；文字方案已保存");
        const quotes=await Promise.all(filmPlan.shots.map(s=>caller.gen.estimate({modelId:model.id,seconds:Math.ceil(s.durationSec)})));
        if(quotes.some(q=>q.estimate.cny===null||!q.allowed)) throw new DirectorJobError("BUDGET_UNKNOWN","视频费用无法核实或已超过上限，未启动媒资制作");
        const preproductionReserve=Number(process.env.WORKLOOM_DIRECTOR_PREPRODUCTION_RESERVE_CNY??0);
        if(!(preproductionReserve>0)) throw new DirectorJobError("PREPRODUCTION_BUDGET_REQUIRED","请在设置中给定妆和图像准备设置预算上限；不能用未知费用开始制作");
        const estimated=quotes.reduce((sum,q)=>sum+(q.estimate.cny??0),0)+preproductionReserve;
        if(estimated>budget) throw new DirectorJobError("PROJECT_BUDGET_EXCEEDED","共享镜头与准备成本超过项目预算，未提交媒体生成");
        const providerRefs=identities.map(a=>String(a.meta.arkAssetUri??(typeof a.meta.realPersonAsset==="object"&&a.meta.realPersonAsset?`asset://${(a.meta.realPersonAsset as Record<string,unknown>).assetId??""}`:"")));
        if(providerRefs.some(ref=>!/^asset:\/\/[A-Za-z0-9._-]{6,}$/u.test(ref))) throw new DirectorJobError("IDENTITY_PROVIDER_ASSET_REQUIRED","本人素材需要先同步为当前模型已授权的真人资产，不能用普通图片替代授权引用");
        let source:Awaited<ReturnType<typeof caller.production.shots>>|null=null;
        try { source=await caller.production.shots({projectId:job.project_id}); }
        catch(error) { if(!/PREPRODUCTION_REQUIRED|SOURCE_NOT_FOUND|PREPRODUCTION_SOURCE_NOT_FOUND/u.test(safeError(error))) throw error; }
        if(!source) {
          await checkpoint("制作共享镜头方案",{estimatedCny:estimated,budgetCny:budget});
          const runId=`DR-${job.id}`;
          const delegation=await directorTx(scope,client=>createDirectorGrantOnClient(client,{...scope,projectId:job.project_id,runId},
            {id:job.created_by,type:"human"},{identityAssetRefs:identities.map(a=>a.id),maxBudgetCny:budget}));
          progress={...progress,imageApiCalls:null,imageApiCallEvidence:"preproduction-ledger",preproductionRunId:runId};
          startRun(scope,{projectId:job.project_id,allocatedRunId:runId,creativeDelegation:delegation,deliveryTargetPlan:filmPlan.deliveryTargetPlan,
            rawIntent:filmPlan.intent,intent:filmPlan.intent+`\n本次共享镜头池固定 ${filmPlan.shots.length} 镜，镜号、完整台词和角色动作不得增删。`
              +"\n冻结导演方案，按此制作："+JSON.stringify(filmPlan),
            metadata:{creativeMode:"director_auto",directorFilmPlan:filmPlan,directorIdentityImages:identities.map(a=>a.path),maxBudgetCny:budget}});
          while(true) {
            await checkpoint("制作共享镜头方案",{preproductionRunId:runId});
            const run=getRun(runId,scope.workspaceId);
            if(!run) throw new DirectorJobError("PREPRODUCTION_INTERRUPTED","预生产工人已停止，请根据档案恢复");
            if(run.status==="failed") throw new DirectorJobError("PREPRODUCTION_FAILED",run.error??"预生产失败");
            if(run.status==="finished") break;
            if(run.status==="awaiting_approval") await checkpoint("等待必要审批",{approvalId:run.pendingApprovalId,gate:run.currentGate});
            await delay(2500,abort.signal);
          }
          caller=videoRouter.createCaller(await authority());source=await caller.production.shots({projectId:job.project_id});
        }
        const canonical=(id:string)=>id.replace(/^SC-0*(\d+)$/u,(_all,n:string)=>`SC-${Number(n)}`);
        if(source.shots.length!==filmPlan.shots.length||source.shots.some(s=>!filmPlan.shots.some(p=>canonical(p.shotId)===canonical(s.shotId))))
          throw new DirectorJobError("FROZEN_SHOT_POOL_MISMATCH","预生产镜头与冻结导演方案不一致，未提交视频；需要复核本次共享镜头方案");
        const actualQuotes=await Promise.all(source.shots.map(s=>caller.gen.estimate({modelId:model.id,seconds:s.durationSec})));
        if(actualQuotes.some(q=>q.estimate.cny===null||!q.allowed)||actualQuotes.reduce((sum,q)=>sum+(q.estimate.cny??0),0)+preproductionReserve>budget)
          throw new DirectorJobError("PROJECT_BUDGET_EXCEEDED","正式镜头计划超过已授权预算，没有提交视频");
        const qualifiedShots:Array<{shotId:string;qualificationToken:string;scriptId:string;scriptVersion:number}>=[];
        for(const shot of source.shots) {
          await checkpoint("复核共享镜头的正式请求");caller=videoRouter.createCaller(await authority());
          const qualified=await caller.production.qualifyShot({projectId:job.project_id,shotId:shot.shotId,modelId:model.id,
            mode:"auto",params:{durationSec:shot.durationSec,aspectRatio:"9:16",generateAudio:false,...(providerRefs.length?{referenceImageUrls:providerRefs}:{})}});
          qualifiedShots.push({shotId:shot.shotId,qualificationToken:qualified.qualificationToken,scriptId:qualified.scriptId,scriptVersion:qualified.scriptVersion});
        }
        const scripts=await caller.cms.listScripts({projectId:job.project_id});
        if(!renderSubmitAutoAllowed() && qualifiedShots.some(q=>scripts.find(s=>s.id===q.scriptId)?.status==="draft")) {
          await updateDirectorJob(scope,job.id,"requires-generation-plan",{...progress,stage:"等待一次制作预算审批",requiredApproval:"G8",
            qualifiedShots,estimatedCny:estimated,budgetCny:budget,mediaReady:false,
            message:"全部正式镜头请求已冻结。一次预算审批覆盖这批共享镜头；后续四版后期无需再次生成镜头"});return;
        }
        const generated:Array<{shotId:string;jobId:string}>=[];
        for(const qualified of qualifiedShots) {
          await checkpoint("生成共享镜头",{generated});caller=videoRouter.createCaller(await authority());
          const submitted=await caller.render.submit({qualificationToken:qualified.qualificationToken});
          generated.push({shotId:qualified.shotId,jobId:submitted.jobId});progress={...progress,renderApiCalls:Number(progress.renderApiCalls??0)+(submitted.deduped?0:1)};
        }
        const completed:Array<{shotId:string;assetId:string}>=[];
        while(completed.length<generated.length) {
          await checkpoint("等待共享镜头产出",{generated,readyShots:completed.length});caller=videoRouter.createCaller(await authority());
          await caller.render.poll({limit:100});
          const rows=await caller.gen.jobs({projectId:job.project_id,limit:100});
          completed.splice(0,completed.length);
          for(const ref of generated) {
            const row=rows.find(r=>r.id===ref.jobId);
            if(row?.status==="failed") throw new DirectorJobError("SOURCE_GENERATION_FAILED",`镜头 ${ref.shotId} 失败；不自动重复烧额度`);
            if(row?.status==="done"&&row.asset_id) completed.push({shotId:ref.shotId,assetId:row.asset_id});
          }
          if(completed.length<generated.length) await delay(5000,abort.signal);
        }
        clips=await loadClips(scope,job.project_id,completed,filmPlan,measure,bins);
      }
      await authority();await checkpoint("重建四支作品的剪辑和声音");
      const revision=(frozen?.revision??0)+1;
      const withAudio=await prepareDirectorAudio(scope,{projectId:job.project_id,revision,clips,filmPlan,by:job.created_by,deadlineMs});
      const project={projectId:job.project_id,...scope,revision,audioScope:{...scope,projectId:job.project_id,revision},creativeMode:"director_auto",
        deliveryTargetPlan:filmPlan.deliveryTargetPlan,directorFilmPlan:filmPlan,intent:filmPlan.intent,title:String(filmPlan.brief.title),fps:30,aspect:"9:16",
        chronologyLocked:filmPlan.brief.chronologyLocked,quality:"hd"};
      result=await post.buildDirectorDelivery({project,shots:withAudio,outDir:path.join(base,`delivery-v${revision}`),burnSubtitles:true,softSubtitles:true,bins,env,
        subtitles:{zhCues:subtitleCues(clips)}});
    }
    await authority();await checkpoint("复检并登记作品");
    const variants=await registerDirectorVariants(scope,job.project_id,result,job.created_by);
    const snapshot=JSON.parse(await readFile(result.projectPath,"utf8"));
    const freeze=await freezeDirectorPlan(scope,job.project_id,{filmPlan,sourceManifest:snapshot.prepared.sourceManifest,
      variantPlans:snapshot.plans,sourceRefs:snapshot.shots.map((s:any)=>({shotId:s.shotId,assetId:s.assetId,sha256:s.sha256})),by:job.created_by});
    const status:DirectorJobStatus=result.status==="complete"?"complete":"partial";
    await updateDirectorJob(scope,job.id,status,{...progress,stage:status==="complete"?"作品已完成":"部分作品已完成，详情中保留失败原因",
      planHash:freeze.planHash,planRevision:freeze.revision,deliveryRevision:result.revision,variants,difference:result.difference,
      projectPath:result.projectPath,projectSha256:await sha256File(result.projectPath),mediaReady:variants.some(v=>v.status==="complete"),
      sourceGenerationCalls:result.sourceGenerationCalls,feedbackAttribution:result.attribution??null,ordinaryConfirmations:0,
      elapsedMs:Date.now()-new Date(job.created_at).getTime()});
  } catch(error) {
    const message=safeError(error),code=error instanceof DirectorJobError?error.code:message.split(":")[0]?.slice(0,120)??"DIRECTOR_FAILED";
    const current=await readDirectorJob(scope,job.id);
    if(current&&["queued","running"].includes(current.status)) await updateDirectorJob(scope,job.id,"failed",{...progress,stage:"制作遇到问题",message},code);
  } finally {controllers.delete(job.id);await lease.release();}
}
async function completedPackage(scope:{tenantId:string;workspaceId:string},projectId:string) {
  return directorTx(scope,async client=>(await client.query<{receipt:Record<string,unknown>}>(`SELECT receipt FROM video_director_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3
    AND status IN ('complete','partial') AND receipt ? 'projectPath' ORDER BY created_at DESC LIMIT 1`,[scope.tenantId,scope.workspaceId,projectId])).rows[0]?.receipt??null);
}
async function loadClips(scope:{tenantId:string;workspaceId:string},projectId:string,refs:Array<{shotId:string;assetId:string}>,plan:DirectorFilmPlan,measure:any,bins:any) {
  if(!refs.length||new Set(refs.map(r=>r.shotId)).size!==refs.length) throw new DirectorJobError("SOURCE_REFS_INVALID","源镜头为空或重复");
  const clips:SourceClip[]=[];
  const canonical=(id:string)=>id.replace(/^SC-0*(\d+)$/u,(_all,n:string)=>`SC-${Number(n)}`);
  const used=new Set<string>();
  for(const ref of refs) {
    const asset=await resolveDirectorAsset(scope,ref.assetId,{projectId,kinds:["clip","upload_video"]});
    if(asset.license_risk!=="none") throw new DirectorJobError("SOURCE_LICENSE_REQUIRED","素材使用权未核实");
    const media=await measure.probeMedia(asset.path,{bins});
    const planned=plan.shots.find(s=>canonical(s.shotId)===canonical(ref.shotId));
    if(!planned) throw new DirectorJobError("SOURCE_SHOT_UNKNOWN","镜头超出冻结导演方案");
    if(used.has(planned.shotId)) throw new DirectorJobError("SOURCE_REFS_INVALID","源镜头规范化后重复");
    used.add(planned.shotId);
    const durationSec=Number(media.videoDuration??media.duration);
    if(!Number.isFinite(durationSec)||durationSec<=0) throw new DirectorJobError("SOURCE_BAD_MEDIA","源镜头没有有效视频时长");
    clips.push({shotId:planned.shotId,assetId:asset.id,path:asset.path,sha256:asset.sha256,durationSec,role:planned.role,dialogue:planned.dialogue,audio:planned.audio});
  }
  if(plan.shots.some(shot=>!used.has(shot.shotId))) throw new DirectorJobError("SOURCE_SHOT_MISSING","冻结导演方案的共享镜头未齐全，未开始后期交付");
  return clips;
}
function subtitleCues(clips:SourceClip[]) {
  let start=0;const cues=[];
  for(const clip of clips){if(clip.dialogue.trim()) cues.push({startSec:start,endSec:start+clip.durationSec,text:clip.dialogue});start+=clip.durationSec;}
  return cues;
}
