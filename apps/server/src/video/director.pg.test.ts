/** Real PostgreSQL scope, append-only, CAS and queue transactions; no provider calls. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { closeAllPools, getAppPool } from "@workloom/db";
import { buildDirectorDefaults, directorHash, resolveDeliveryTargets, type DirectorFilmPlan } from "@hyperreality/video-studio";
import { directorTx, createDirectorGrantOnClient, verifyDirectorGrant, saveExplicitDirectorPreference, readExplicitDirectorPreferences } from "./director-store.js";
import { queueDirectorJob, readDirectorJob, updateDirectorJob, freezeDirectorPlan, latestDirectorPlan, acquireDirectorLease,
  recoverInterruptedDirectorJob, directorEvent } from "./director-jobs.js";
import { directorRouter, publicDirectorJob } from "./director-router.js";

const enabled=(process.env.RUN_DIRECTOR_DB_TESTS==="1"||process.env.RUN_DB_TESTS==="1")&&Boolean(process.env.DATABASE_APP_URL);
describe.runIf(enabled)("director real PostgreSQL contracts",()=>{
  const owner=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const suffix=randomBytes(6).toString("hex"),scope={tenantId:`director-t-${suffix}`,workspaceId:`director-w-${suffix}`};
  const other={tenantId:`director-other-t-${suffix}`,workspaceId:`director-other-w-${suffix}`};
  let sequence=0;
  const filmPlan={schemaVersion:"workloom.director-film-plan/v2",intent:"雨后民宿",brief:{title:"窗边",chronologyLocked:false},
    shots:[],narrativePlans:[],directorProfile:buildDirectorDefaults({intent:"雨后民宿"}),
    deliveryTargetPlan:resolveDeliveryTargets("雨后民宿"),planHash:directorHash("fixture-plan")} as unknown as DirectorFilmPlan;
  const project=async()=>{
    const id=`director-p-${suffix}-${++sequence}`;
    await owner.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$2,'contract fixture','narrative','MEM-test')",[id,scope.workspaceId]);return id;
  };
  const enqueue=(projectId:string,key=`director-key-${suffix}-${++sequence}`,payload={kind:"contract-fixture"})=>
    queueDirectorJob(scope,{projectId,idempotencyKey:key,by:"MEM-test",payload});
  beforeAll(async()=>{
    for(const item of [scope,other]){
      await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'director contracts','pro')",[item.tenantId]);
      await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'director contracts',$1,'general')",[item.workspaceId,item.tenantId]);
    }
  });
  // Append-only evidence intentionally remains in this dedicated test scope.
  afterAll(async()=>{await owner.end();await closeAllPools();});
  it("migration is applied and all six tables force RLS",async()=>{
    expect((await owner.query("SELECT name FROM _migrations WHERE name='0054_video_director_v2.sql'")).rowCount).toBe(1);
    const rows=(await owner.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('video_creative_delegations','video_director_plans','video_director_jobs','video_director_preferences','video_director_audio_sources','video_director_choices')")).rows;
    expect(rows).toHaveLength(6);expect(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
  });
  it("parallel duplicate input creates one job and one queue event",async()=>{
    const id=await project(),key=`parallel-${suffix}`;
    const calls=await Promise.all(Array.from({length:8},()=>enqueue(id,key)));
    expect(new Set(calls.map(r=>r.job.id)).size).toBe(1);expect(calls.filter(r=>!r.reused)).toHaveLength(1);
    expect((await owner.query("SELECT event_id FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2 AND payload->'decision'->>'action'='video.director.queued'",[scope.workspaceId,id])).rowCount).toBe(1);
  });
  it("same key with changed input and a second active job both reject",async()=>{
    const id=await project(),key=`mismatch-${suffix}`;await enqueue(id,key);
    await expect(enqueue(id,key,{kind:"different"})).rejects.toMatchObject({code:"IDEMPOTENCY_MISMATCH"});
    await expect(enqueue(id)).rejects.toMatchObject({code:"PROJECT_BUSY"});
  });
  it("cross-tenant reads and unscoped reads disclose no job",async()=>{
    const created=await enqueue(await project());
    expect(await readDirectorJob(other,created.job.id)).toBeNull();
    expect((await getAppPool().query("SELECT id FROM video_director_jobs WHERE id=$1",[created.job.id])).rowCount).toBe(0);
  });
  it("project ownership mismatch fails before insert even for owner",async()=>{
    const id=await project();
    await expect(owner.query("INSERT INTO video_director_jobs(id,tenant_id,workspace_id,project_id,revision,idempotency_key,request_hash,status,payload,created_by) VALUES($1,$2,$3,$4,1,$1,$5,'queued','{}','MEM-test')",[`invalid-${suffix}`,other.tenantId,other.workspaceId,id,directorHash("invalid")])).rejects.toThrow(/ownership mismatch/u);
  });
  it("approval hook and queue insert roll back as one transaction",async()=>{
    const id=await project(),key=`atomic-${suffix}`;
    const run=()=>queueDirectorJob(scope,{projectId:id,idempotencyKey:key,by:"MEM-test",payload:{kind:"render"}},
      {beforeInsert:async client=>{await directorEvent(client,scope,id,"video.director.budget.approved",{test:true},{id:"MEM-test",type:"human"});throw new Error("injected queue failure");}});
    await expect(run()).rejects.toThrow("injected queue failure");
    expect((await owner.query("SELECT id FROM video_director_jobs WHERE project_id=$1",[id])).rowCount).toBe(0);
    expect((await owner.query("SELECT event_id FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2",[scope.workspaceId,id])).rowCount).toBe(0);
    let hooks=0;
    const input={projectId:id,idempotencyKey:key,by:"MEM-test",payload:{kind:"render"}};
    const options={beforeInsert:async()=>{hooks++;}};
    await queueDirectorJob(scope,input,options);await queueDirectorJob(scope,input,options);expect(hooks).toBe(1);
  });
  it("terminal receipts and job identity cannot be rewritten or deleted",async()=>{
    const {job}=await enqueue(await project());
    await expect(owner.query("UPDATE video_director_jobs SET request_hash=$2 WHERE id=$1",[job.id,directorHash("changed")])).rejects.toThrow(/identity is immutable/u);
    await updateDirectorJob(scope,job.id,"running",{stage:"fixture"});
    await updateDirectorJob(scope,job.id,"complete",{stage:"complete",renderApiCalls:0});
    await expect(owner.query("UPDATE video_director_jobs SET receipt='{}' WHERE id=$1",[job.id])).rejects.toThrow(/terminal receipt is immutable/u);
    await expect(owner.query("DELETE FROM video_director_jobs WHERE id=$1",[job.id])).rejects.toThrow(/append-only/u);
  });
  it("frozen revision CAS rejects stale edits and evidence mutation",async()=>{
    const id=await project(),first=await freezeDirectorPlan(scope,id,{filmPlan,by:"MEM-test"});
    await freezeDirectorPlan(scope,id,{filmPlan,by:"MEM-test"});
    await expect(queueDirectorJob(scope,{projectId:id,revision:first.revision,expectedPlanHash:first.planHash,idempotencyKey:`stale-${suffix}`,by:"MEM-test",payload:{kind:"revise"}})).rejects.toMatchObject({code:"REVISION_CONFLICT"});
    await expect(owner.query("UPDATE video_director_plans SET target_plan='{}' WHERE project_id=$1",[id])).rejects.toThrow(/append-only/u);
    expect((await latestDirectorPlan(scope,id))?.revision).toBe(2);
  });
  it("creative grant requires the real scoped event and an exact payload",async()=>{
    const id=await project(),grantScope={...scope,projectId:id,runId:`run-${suffix}`};
    const grant=await directorTx(scope,client=>createDirectorGrantOnClient(client,grantScope,{id:"MEM-test",type:"human"}));
    expect((await verifyDirectorGrant(grantScope,grant)).policyHash).toBe(grant.policyHash);
    await expect(verifyDirectorGrant({...other,projectId:id,runId:grantScope.runId},grant)).rejects.toThrow(/DELEGATION/u);
    await expect(verifyDirectorGrant(grantScope,{...grant,grantedBy:"forged"})).rejects.toThrow(/DELEGATION/u);
  });
  it("explicit feedback preserves Unicode and marks attribution as inferred",async()=>{
    const id=await project(),feedback="人物自然一点；别把夜景改成白天 🎬";
    await saveExplicitDirectorPreference(scope,{projectId:id,subjectId:"member-fixture",feedback,attribution:{origin:"inferred",layer:"color"},by:"MEM-test"});
    const prefs=await readExplicitDirectorPreferences(scope,"member-fixture");
    expect(prefs.at(-1)).toEqual({feedback,origin:"explicit",attribution:{origin:"inferred",layer:"color"}});
    expect(await readExplicitDirectorPreferences(other,"member-fixture")).toEqual([]);
  });
  it("session lease excludes a second worker and releases after completion",async()=>{
    const id=await project(),lease=await acquireDirectorLease(scope,id);expect(lease).not.toBeNull();
    expect(await acquireDirectorLease(scope,id)).toBeNull();await lease!.release();
    const second=await acquireDirectorLease(scope,id);expect(second).not.toBeNull();await second!.release();
  });
  it("a dead aged lease becomes interrupted without provider replay",async()=>{
    const {job}=await enqueue(await project());await updateDirectorJob(scope,job.id,"running",{stage:"before crash",renderApiCalls:0});
    await owner.query("UPDATE video_director_jobs SET updated_at=now()-interval '2 minutes' WHERE id=$1",[job.id]);
    const live=await acquireDirectorLease(scope,job.project_id);expect((await recoverInterruptedDirectorJob(scope,job.id))?.status).toBe("running");
    await live!.release();const recovered=await recoverInterruptedDirectorJob(scope,job.id);expect(recovered?.status).toBe("interrupted");
    expect(recovered?.receipt?.renderApiCalls).toBe(0);
  });
  it("anonymous APIs fail authorization and public receipts strip private material",async()=>{
    const caller=directorRouter.createCaller({identity:null,session:null,partnerIdentity:null,headers:new Headers()});
    await expect(caller.resolveTargets({intent:"雨后民宿"})).rejects.toMatchObject({code:"UNAUTHORIZED"});
    const {job}=await enqueue(await project());const exposed=publicDirectorJob({...job,receipt:{projectPath:"/private/project.json",qualificationToken:"private-token",variants:[{id:"v",status:"complete",videoPath:"/private/v.mp4",videoUrl:"/video/v",personQc:{samples:[{path:"/private/frame.png"}]}}]}});
    expect(JSON.stringify(exposed)).not.toMatch(/private|qualificationToken|projectPath/u);
  });
});
