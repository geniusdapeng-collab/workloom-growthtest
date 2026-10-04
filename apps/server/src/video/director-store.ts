/** Trusted service storage. Request fields never authorize creative decisions or source media. */
import type pg from "pg";
import { getAppPool } from "@workloom/db";
import { newId } from "@workloom/shared";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { createCreativeDelegation, validateCreativeDelegation, directorHash,
  type CreativeDelegation, type DirectorScope } from "@hyperreality/video-studio";

export interface CreativeScope { tenantId: string; workspaceId: string }
export async function directorTx<T>(scope:CreativeScope,run:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const client=await getAppPool().connect();let discard=false;
  try {await client.query("BEGIN");await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)",[scope.tenantId,scope.workspaceId]);
    const result=await run(client);await client.query("COMMIT");return result;
  } catch(error) {try {await client.query("ROLLBACK");}catch(rollback){discard=true;throw new AggregateError([error,rollback],"director transaction rollback failed");}throw error;}
  finally {client.release(discard);}
}
export async function createDirectorGrantOnClient(client:pg.PoolClient,scope:DirectorScope&{runId:string},actor:{id:string;type:"human"|"system"},options:{identityAssetRefs?:string[];maxBudgetCny?:number}={}):Promise<CreativeDelegation> {
  const event=await gatewayAppendOnClient(client,{...scope,actor},{who:actor,
    context:{tenant_id:scope.tenantId,workspace_id:scope.workspaceId,time:new Date().toISOString(),channel:"inapp"},
    object:{type:"video_project",id:scope.projectId},decision:{action:"video.creative.delegated",after:{runId:scope.runId,
      creativeMode:"director_auto",identityAssetRefs:options.identityAssetRefs??[],maxBudgetCny:options.maxBudgetCny??0,
      excludes:["identity-authorization","extra-charge","publish","credentials","delete"]},
      basis:["用户发起一句话委托；普通导演制作决策由 AI 承担，资金和对外权限沿用原围栏"]},rule_impact:[]});
  const delegation=createCreativeDelegation({...scope,grantedBy:actor.id,grantEventId:event.eventId,...options});
  await client.query(`INSERT INTO video_creative_delegations (tenant_id,workspace_id,project_id,run_id,grant_event_id,policy_hash,payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,[scope.tenantId,scope.workspaceId,scope.projectId,scope.runId,event.eventId,delegation.policyHash,delegation]);
  return delegation;
}
export async function verifyDirectorGrant(scope:DirectorScope&{runId:string},provided:unknown):Promise<CreativeDelegation> {
  const result=validateCreativeDelegation(provided,scope);
  if(!result.valid) throw new Error(`${result.reason}：创作委托无效`);
  return directorTx(scope,async client=>{
    const rows=await client.query<{payload:CreativeDelegation;actor:string;run_id:string;grant_event_id:string}>(`SELECT d.payload,e.payload->'who'->>'id' AS actor,
      e.payload->'decision'->'after'->>'runId' AS run_id,e.event_id AS grant_event_id FROM video_creative_delegations d
      JOIN biz_events e ON e.tenant_id=d.tenant_id AND e.workspace_id=d.workspace_id AND e.event_id=d.grant_event_id
      WHERE d.tenant_id=$1 AND d.workspace_id=$2 AND d.project_id=$3 AND d.run_id=$4 AND e.payload->'object'->>'id'=$3
        AND e.payload->'decision'->>'action'='video.creative.delegated'`,[scope.tenantId,scope.workspaceId,scope.projectId,scope.runId]);
    const row=rows.rows[0];
    if(!row || directorHash(row.payload)!==directorHash(provided) || row.actor!==row.payload.grantedBy || row.run_id!==scope.runId
      || row.grant_event_id!==row.payload.grantEventId) throw new Error("DELEGATION_INVALID：没有当前作用域真实委托事件");
    return row.payload;
  });
}
export async function saveExplicitDirectorPreference(scope:CreativeScope,input:{projectId:string;subjectId:string;feedback:string;attribution:Record<string,unknown>;by:string}):Promise<string> {
  return directorTx(scope,async client=>{
    const event=await gatewayAppendOnClient(client,{...scope,actor:{id:input.by,type:"human"}},{who:{id:input.by,type:"human"},
      context:{tenant_id:scope.tenantId,workspace_id:scope.workspaceId,time:new Date().toISOString(),channel:"inapp"},
      object:{type:"video_project",id:input.projectId},decision:{action:"video.creative.feedback",after:{feedback:input.feedback,
        attribution:input.attribution,origin:"explicit",attributionOrigin:"inferred"},basis:["客户原话只增保存；技术归因保持推断来源"]},rule_impact:[]});
    const id=newId("DPR");
    await client.query(`INSERT INTO video_director_preferences(id,tenant_id,workspace_id,subject_id,project_id,source_event_id,feedback,origin,attribution)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'explicit',$8)`,[id,scope.tenantId,scope.workspaceId,input.subjectId,input.projectId,event.eventId,input.feedback,input.attribution]);return id;
  });
}
export async function readExplicitDirectorPreferences(scope:CreativeScope,subjectId:string):Promise<Array<{feedback:string;origin:"explicit";attribution:Record<string,unknown>}>> {
  return directorTx(scope,async client=>(await client.query<{feedback:string;origin:"explicit";attribution:Record<string,unknown>}>(
    `SELECT feedback,origin,attribution FROM video_director_preferences WHERE tenant_id=$1 AND workspace_id=$2 AND subject_id=$3 ORDER BY created_at DESC LIMIT 20`,[scope.tenantId,scope.workspaceId,subjectId])).rows.reverse());
}
