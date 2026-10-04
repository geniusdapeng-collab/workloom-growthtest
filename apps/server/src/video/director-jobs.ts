/** Scoped durable director queue. A completed receipt is immutable; retries use a new job. */
import { getAppPool } from "@workloom/db";
import { gatewayAppendOnClient, insertWithReadableId, VIDEO_PROJECT_ID_SOURCE } from "@workloom/base/workdata";
import { newId } from "@workloom/shared";
import { directorHash, type DirectorFilmPlan } from "@hyperreality/video-studio";
import { directorTx, type CreativeScope } from "./director-store.js";

export type DirectorJobStatus="queued"|"running"|"complete"|"partial"|"failed"|"interrupted"|"requires-generation-plan";
export interface DirectorJob {id:string;tenant_id:string;workspace_id:string;project_id:string;revision:number;
  idempotency_key:string;request_hash:string;status:DirectorJobStatus;payload:Record<string,unknown>;
  receipt:Record<string,unknown>|null;error_code:string|null;created_by:string;created_at:Date;updated_at:Date}
export class DirectorJobError extends Error {
  constructor(readonly code:string,message:string){super(`${code}: ${message}`);this.name="DirectorJobError";}
}
export async function directorEvent(client:import("pg").PoolClient,scope:CreativeScope,projectId:string,
  action:string,after:Record<string,unknown>,actor:{id:string;type:"human"|"system"}) {
  return gatewayAppendOnClient(client,{...scope,actor},{who:actor,
    context:{tenant_id:scope.tenantId,workspace_id:scope.workspaceId,time:new Date().toISOString(),channel:"inapp"},
    object:{type:"video_project",id:projectId},decision:{action,after,basis:["导演 V2：冻结输入、只增证据、按真实执行回执交付"]},rule_impact:[]});
}
export async function queueDirectorJob(scope:CreativeScope,input:{projectId?:string;revision?:number;intent?:string;
  payload:Record<string,unknown>;idempotencyKey:string;by:string;expectedPlanHash?:string},
  options:{beforeInsert?:(client:import("pg").PoolClient,projectId:string)=>Promise<void>}={}) {
  return directorTx(scope,async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`${scope.tenantId}/${scope.workspaceId}/director-key/${input.idempotencyKey}`]);
    const requestHash=directorHash({projectId:input.projectId??null,revision:input.revision??null,intent:input.intent??null,
      payload:input.payload,expectedPlanHash:input.expectedPlanHash??null});
    const prior=(await client.query<DirectorJob>(`SELECT * FROM video_director_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3`,
      [scope.tenantId,scope.workspaceId,input.idempotencyKey])).rows[0];
    if(prior) {
      if(prior.request_hash!==requestHash) throw new DirectorJobError("IDEMPOTENCY_MISMATCH","同幂等键绑定了不同内容");
      return {job:prior,reused:true};
    }
    let projectId=input.projectId;
    if(!projectId) {
      if(!input.intent?.trim()) throw new DirectorJobError("INTENT_REQUIRED","请用一句话描述想做的作品");
      projectId=(await insertWithReadableId(client,VIDEO_PROJECT_ID_SOURCE,async id=>{
        await client.query(`INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$2,$3,'narrative',$4)`,
          [id,scope.workspaceId,input.intent!.slice(0,200),input.by]);return id;
      })).id;
      await directorEvent(client,scope,projectId,"video.project.create",{creativeMode:"director_auto",intent:input.intent},{id:input.by,type:"human"});
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`${scope.tenantId}/${scope.workspaceId}/director/${projectId}`]);
    const project=(await client.query(`SELECT id FROM video_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,[projectId,scope.workspaceId])).rows[0];
    if(!project) throw new DirectorJobError("PROJECT_NOT_FOUND","项目不存在或不属于当前工作区");
    const current=(await client.query<{revision:number;plan_hash:string}>(`SELECT revision,plan_hash FROM video_director_plans
      WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 ORDER BY revision DESC LIMIT 1`,[scope.tenantId,scope.workspaceId,projectId])).rows[0];
    if(input.expectedPlanHash && (current?.plan_hash!==input.expectedPlanHash || current.revision!==input.revision))
      throw new DirectorJobError("REVISION_CONFLICT","作品已有新版本，请刷新后提交意见");
    const active=(await client.query(`SELECT id FROM video_director_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND status IN ('queued','running')`,
      [scope.tenantId,scope.workspaceId,projectId])).rows[0];
    if(active) throw new DirectorJobError("PROJECT_BUSY","这个项目正在制作，重复操作不会启动第二次制作");
    // Approval and the continuing job commit together. An idempotent replay has
    // already returned, so it never appends a second approval event.
    await options.beforeInsert?.(client,projectId);
    const id=newId("DJ"),revision=input.revision??(current?.revision??0)+1;
    const job=(await client.query<DirectorJob>(`INSERT INTO video_director_jobs(id,tenant_id,workspace_id,project_id,revision,idempotency_key,request_hash,status,payload,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9) RETURNING *`,
      [id,scope.tenantId,scope.workspaceId,projectId,revision,input.idempotencyKey,requestHash,{...input.payload,intent:input.intent??input.payload.intent??null},input.by])).rows[0]!;
    await directorEvent(client,scope,projectId,"video.director.queued",{jobId:id,revision,requestHash,kind:input.payload.kind},{id:input.by,type:"human"});
    return {job,reused:false};
  });
}
export async function readDirectorJob(scope:CreativeScope,id:string) {
  return directorTx(scope,async client=>(await client.query<DirectorJob>(`SELECT * FROM video_director_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
    [scope.tenantId,scope.workspaceId,id])).rows[0]??null);
}
export async function updateDirectorJob(scope:CreativeScope,id:string,status:DirectorJobStatus,receipt:Record<string,unknown>,errorCode:string|null=null) {
  return directorTx(scope,async client=>{
    const row=(await client.query<DirectorJob>(`UPDATE video_director_jobs SET status=$4,receipt=$5,error_code=$6,updated_at=now()
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status IN ('queued','running') RETURNING *`,
      [scope.tenantId,scope.workspaceId,id,status,receipt,errorCode])).rows[0];
    if(!row) throw new DirectorJobError("JOB_STATE_CONFLICT","任务已终止，禁止覆盖原回执");
    if(status!=="running") await directorEvent(client,scope,row.project_id,`video.director.${status}`,{jobId:id,revision:row.revision,
      receiptHash:directorHash(receipt),errorCode},{id:"video-director",type:"system"});return row;
  });
}
export async function freezeDirectorPlan(scope:CreativeScope,projectId:string,input:{filmPlan:DirectorFilmPlan;revision?:number;
  sourceManifest?:unknown;variantPlans?:unknown;sourceRefs?:unknown;by:string}) {
  return directorTx(scope,async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`${scope.tenantId}/${scope.workspaceId}/director/${projectId}`]);
    const latest=(await client.query<{revision:number}>(`SELECT revision FROM video_director_plans WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 ORDER BY revision DESC LIMIT 1`,
      [scope.tenantId,scope.workspaceId,projectId])).rows[0];
    const revision=input.revision??(latest?.revision??0)+1;
    if(revision!==(latest?.revision??0)+1) throw new DirectorJobError("REVISION_CONFLICT","冻结版本必须接在当前版本之后");
    const body={filmPlan:input.filmPlan,targetPlan:input.filmPlan.deliveryTargetPlan,sourceManifest:input.sourceManifest??{},variantPlans:input.variantPlans??[],sourceRefs:input.sourceRefs??[],revision};
    const planHash=directorHash(body);
    // pg treats JavaScript arrays as PostgreSQL arrays. Explicit JSON encoding
    // preserves both [] and populated media manifests in JSONB columns.
    await client.query(`INSERT INTO video_director_plans(tenant_id,workspace_id,project_id,revision,plan_hash,target_plan,source_manifest,variant_plans,film_plan,source_refs,created_by)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,[scope.tenantId,scope.workspaceId,projectId,revision,planHash,
      JSON.stringify(body.targetPlan),JSON.stringify(body.sourceManifest),JSON.stringify(body.variantPlans),JSON.stringify(input.filmPlan),JSON.stringify(body.sourceRefs),input.by]);
    await directorEvent(client,scope,projectId,"video.director.plan.frozen",{revision,planHash,filmPlanHash:input.filmPlan.planHash,
      expectedOutputs:input.filmPlan.deliveryTargetPlan.expectedOutputs},{id:"video-director",type:"system"});return {revision,planHash};
  });
}
export interface FrozenDirectorPlan {revision:number;plan_hash:string;target_plan:DirectorFilmPlan["deliveryTargetPlan"];
  source_manifest:Record<string,unknown>;variant_plans:Array<Record<string,unknown>>;film_plan:DirectorFilmPlan;source_refs:Array<Record<string,unknown>>}
export async function latestDirectorPlan(scope:CreativeScope,projectId:string) {
  return directorTx(scope,async client=>(await client.query<FrozenDirectorPlan>(`SELECT revision,plan_hash,target_plan,source_manifest,variant_plans,film_plan,source_refs FROM video_director_plans
    WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 ORDER BY revision DESC LIMIT 1`,[scope.tenantId,scope.workspaceId,projectId])).rows[0]??null);
}
/** Session lease survives transaction commits and releases on a killed host. */
export async function acquireDirectorLease(scope:CreativeScope,projectId:string,onLost:(error:Error)=>void=()=>{}) {
  const client=await getAppPool().connect();
  try {
    const key=`director-worker/${scope.tenantId}/${scope.workspaceId}/${projectId}`;
    const held=(await client.query<{held:boolean}>("SELECT pg_try_advisory_lock(hashtext($1)) AS held",[key])).rows[0]?.held;
    if(!held){client.release();return null;}
    let lost=false;
    const listener=(error:Error)=>{lost=true;onLost(error);};client.on("error",listener);
    return {release:async()=>{try{if(!lost) await client.query("SELECT pg_advisory_unlock(hashtext($1))",[key]);}
      finally{client.removeListener("error",listener);client.release(lost);}}};
  } catch(error){client.release(true);throw error;}
}
/** A dead lease is evidence of interruption, never authorization to replay a paid submission. */
export async function recoverInterruptedDirectorJob(scope:CreativeScope,id:string) {
  const job=await readDirectorJob(scope,id);
  if(!job || !["queued","running"].includes(job.status) || Date.now()-new Date(job.updated_at).getTime()<60_000) return job;
  const lease=await acquireDirectorLease(scope,job.project_id);
  if(!lease) return job;
  try {
    const current=await readDirectorJob(scope,id);
    if(!current || !["queued","running"].includes(current.status) || Date.now()-new Date(current.updated_at).getTime()<60_000) return current;
    return await updateDirectorJob(scope,id,"interrupted",{...current.receipt,stage:"上次制作被中断",
      message:"执行进程的项目租约已经释放。保留已派发任务和回执；请核对已有镜头后继续，系统没有自动重发媒体请求"},"DIRECTOR_HOST_INTERRUPTED");
  } finally {await lease.release();}
}
