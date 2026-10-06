/** Host-only independent audio producer. Nothing in the public API accepts paths or signed receipts. */
import path from "node:path";
import { mkdir, realpath, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { newId } from "@workloom/shared";
import { videoRuntimeRoot, directorHash, buildSfxArgs, type DirectorFilmPlan } from "@hyperreality/video-studio";
import { directorTx, type CreativeScope } from "./director-store.js";
import { directorEvent, DirectorJobError } from "./director-jobs.js";
import { mediaRoot, mediaUrl, workspaceIdFromMediaPath } from "./gen/ingest.js";
import { resolveInside, safeSegment } from "./media/paths.js";
import { sha256File, registerLocalAsset } from "./media/register-local.js";

export function directorWorkRoot(env:NodeJS.ProcessEnv=process.env) {
  return path.resolve(env.WORKLOOM_DIRECTOR_DIR??path.join(path.dirname(mediaRoot(env)),"director"));
}
export async function directorConnectors({mediaRuntime=false,onProgress=(_stage:string)=>{}}:{mediaRuntime?:boolean;onProgress?:(stage:string)=>void}={}) {
  const root=videoRuntimeRoot(import.meta.url);
  const load=(ref:string)=>import(pathToFileURL(path.join(root,"bundles/ai-video",ref)).href);
  const [post,voice,stems,authority,measure]=await Promise.all([
    load("connectors/post-bridge/director-delivery.mjs"),load("connectors/voice-bridge/core.mjs"),
    load("connectors/bgm-bridge/audio-stems.mjs"),load("library/director-system/audio-authority.mjs"),
    load("connectors/subtitle-bridge/measure.mjs")]);
  const work=directorWorkRoot();await mkdir(work,{recursive:true});await mkdir(mediaRoot(),{recursive:true});
  const roots=[work,mediaRoot(),root];
  const env:NodeJS.ProcessEnv={...process.env,WORKLOOM_POST_ALLOWED_ROOTS:JSON.stringify(roots),WORKLOOM_COLOR_ALLOWED_ROOTS:JSON.stringify(roots),
    WORKLOOM_SUBTITLE_ALLOWED_ROOTS:JSON.stringify(roots),WORKLOOM_BGM_ALLOWED_ROOTS:JSON.stringify(roots),WORKLOOM_VOICE_ALLOWED_ROOTS:JSON.stringify(roots),
    WORKLOOM_BGM_DISCOVER:"0",WORKLOOM_BGM_HOME:path.join(work,"music")};
  let bins={ffmpeg:process.env.WL_FFMPEG??process.env.FFMPEG_PATH??"ffmpeg",ffprobe:process.env.WL_FFPROBE??process.env.FFPROBE_PATH??"ffprobe"};
  if(mediaRuntime && !(process.env.WL_FFMPEG&&process.env.WL_FFPROBE)) {
    const installer=await import(pathToFileURL(path.join(root,"scripts/media-runtime.mjs")).href);
    const installed=await installer.ensureMediaRuntime({cacheDir:path.join(work,"media-tools"),onProgress});
    bins={ffmpeg:installed.ffmpeg,ffprobe:installed.ffprobe};
  }
  return {root,post,voice,stems,authority,measure,env,bins};
}
export interface DirectorAsset {id:string;kind:string;sha256:string;meta:Record<string,unknown>;provenance:Record<string,unknown>;
  license_risk:string;status:string;project_id:string|null;path:string;relPath:string}
export async function resolveDirectorAsset(scope:CreativeScope,assetId:string,options:{projectId?:string;kinds:string[]}) {
  const row=await directorTx(scope,async client=>(await client.query<Omit<DirectorAsset,"path"|"relPath">>(`SELECT id,kind,sha256,meta,provenance,license_risk,status,project_id FROM video_assets
    WHERE workspace_id=$1 AND id=$2 AND status<>'archived'`,[scope.workspaceId,assetId])).rows[0]);
  if(!row || !options.kinds.includes(row.kind) || options.projectId && row.project_id!==options.projectId)
    throw new DirectorJobError("ASSET_NOT_FOUND","素材不存在、类型不适用或不属于这个项目");
  const relPath=String(row.meta.localPath??"");
  if(workspaceIdFromMediaPath(relPath)!==scope.workspaceId) throw new DirectorJobError("ASSET_SCOPE_MISMATCH","素材存储与工作区不一致");
  const root=await realpath(mediaRoot()),file=await realpath(resolveInside(root,relPath));
  if(!file.startsWith(root+path.sep)||await sha256File(file)!==row.sha256) throw new DirectorJobError("SOURCE_CHANGED","素材字节与库内哈希不一致");
  return {...row,path:file,relPath};
}
/** Consent is recorded by an authenticated human on their own uploaded asset; a filename is never consent. */
export async function bindOwnDirectorIdentity(scope:CreativeScope,assetId:string,by:string) {
  const asset=await resolveDirectorAsset(scope,assetId,{kinds:["upload_image","reference_image","portrait"]});
  return directorTx(scope,async client=>{
    const owner=(await client.query<{created_by:string}>("SELECT created_by FROM video_assets WHERE workspace_id=$1 AND id=$2",[scope.workspaceId,assetId])).rows[0];
    if(owner?.created_by!==by) throw new DirectorJobError("IDENTITY_OWNER_REQUIRED","只能为自己上传的本人素材授权；其他人的素材须走原有授权流程");
    const event=await gatewayAppendOnClient(client,{...scope,actor:{id:by,type:"human"}},{who:{id:by,type:"human"},
      context:{tenant_id:scope.tenantId,workspace_id:scope.workspaceId,time:new Date().toISOString(),channel:"inapp"},object:{type:"video_asset",id:assetId},
      decision:{action:"video.director.identity.authorized",after:{assetId,sha256:asset.sha256,subjectId:by,use:"self-portrait-in-this-workspace",expiresAt:null},
        basis:["本人明确将自己的素材用于当前工作区内的形象制作；不授权声纹克隆或公开发布"]},rule_impact:[]});
    return {assetId,eventId:event.eventId,sha256:asset.sha256};
  });
}
export async function resolveDirectorIdentities(scope:CreativeScope,by:string,requested?:string[]) {
  const facts=await directorTx(scope,async client=>(await client.query<{asset_id:string;sha256:string}>(`SELECT DISTINCT ON (e.payload->'object'->>'id') e.payload->'object'->>'id' AS asset_id,
    e.payload->'decision'->'after'->>'sha256' AS sha256 FROM biz_events e WHERE tenant_id=$1 AND workspace_id=$2
    AND e.payload->'who'->>'type'='human' AND e.payload->'who'->>'id'=$3 AND e.payload->'decision'->>'action'='video.director.identity.authorized'
    AND e.payload->'decision'->'after'->>'subjectId'=$3 ORDER BY e.payload->'object'->>'id',e.seq DESC`,[scope.tenantId,scope.workspaceId,by])).rows);
  const ids=requested?.length?requested:facts.map(f=>f.asset_id).slice(0,4),assets:DirectorAsset[]=[];
  for(const id of ids) {
    const asset=await resolveDirectorAsset(scope,id,{kinds:["upload_image","reference_image","portrait"]});
    if(!facts.some(f=>f.asset_id===id&&f.sha256===asset.sha256)) throw new DirectorJobError("IDENTITY_AUTHORIZATION_REQUIRED","本人形象素材未有当前字节的授权记录");
    assets.push(asset);
  }
  return assets;
}
export interface SourceClip {shotId:string;assetId:string;path:string;sha256:string;durationSec:number;role?:string;dialogue:string;audio?:Record<string,unknown>}
export async function preflightDirectorAudio(filmPlan:DirectorFilmPlan,connectors:Awaited<ReturnType<typeof directorConnectors>>) {
  const {voice,env,bins,measure}=connectors;
  if(!env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET || Buffer.byteLength(env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET)<32)
    throw new DirectorJobError("AUDIO_AUTHORITY_UNAVAILABLE","缺少独立声音签发密钥，未开始付费媒资准备");
  await Promise.all([bins.ffmpeg,bins.ffprobe].map(bin=>measure.runBin(bin,["-hide_banner","-version"],{timeoutMs:20_000})));
  if(filmPlan.shots.some(shot=>shot.dialogue.trim())) {
    const config=voice.engineConfig(env),endpoint=new URL(config.baseUrl);
    if(config.kind==="mock"||!["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname))
      throw new DirectorJobError("VOICE_SOURCE_UNAVAILABLE","旁白需要已连接的本机真实声音引擎，未开始付费媒资准备");
    if(filmPlan.shots.some(shot=>shot.dialogue.trim()&&!/(旁白|画外|离画|off.?camera|voice.?over|narration)/iu.test(shot.audio.dialogue)))
      throw new DirectorJobError("DIALOGUE_SOURCE_REQUIRED","可见口型台词需要独立原始对白与口型证据，未开始付费媒资准备");
    const health=await voice.probeEngine(config);
    if(!health.reachable) throw new DirectorJobError("VOICE_SOURCE_UNAVAILABLE","本机旁白引擎不可用，未开始付费媒资准备");
  }
}
export async function prepareDirectorAudio(scope:CreativeScope,input:{projectId:string;revision:number;clips:SourceClip[];filmPlan:DirectorFilmPlan;by:string;deadlineMs:number}) {
  const {voice,stems,authority,measure,env,bins}=await directorConnectors({mediaRuntime:true});
  if(!env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET || Buffer.byteLength(env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET)<32)
    throw new DirectorJobError("AUDIO_AUTHORITY_UNAVAILABLE","客户端未生成独立声音签发密钥，请运行客户端修复检查");
  const audioScope={...scope,projectId:input.projectId,revision:input.revision};
  const dir=path.join(directorWorkRoot(),safeSegment(scope.workspaceId),safeSegment(input.projectId),`audio-v${input.revision}`);
  await mkdir(dir,{recursive:true});
  const shots:Array<Record<string,any>>=[];
  for(const clip of input.clips) {
    if(Date.now()>=input.deadlineMs) throw new DirectorJobError("DIRECTOR_TIMEOUT","声音准备超时，未重发任何生成请求");
    const planned=input.filmPlan.shots.find(s=>s.shotId===clip.shotId);
    if(!planned) throw new DirectorJobError("SOURCE_SHOT_UNKNOWN","独立声音的镜头不在冻结导演方案内");
    const audio:Record<string,any>={};
    for(const role of ["dialogue","ambience","foley","music"] as const) {
      const jobId=newId("DAS"),out=path.join(dir,`${safeSegment(clip.shotId)}-${role}-${jobId}.wav`);
      const description=String(planned?.audio[role as keyof typeof planned.audio]??"");
      let source:Record<string,unknown>;
      if(role==="dialogue" && clip.dialogue.trim()) {
        if(!/(旁白|画外|离画|off.?camera|voice.?over|narration)/iu.test(description))
          throw new DirectorJobError("DIALOGUE_SOURCE_REQUIRED","可见口型对白需要原始独立对白和口型证据；不会用另一条配音覆盖混合成片");
        const config=voice.engineConfig(env),endpoint=new URL(config.baseUrl);
        if(config.kind==="mock" || !["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname))
          throw new DirectorJobError("VOICE_SOURCE_UNAVAILABLE","自动旁白需要已配置的本机真实配音引擎；远端付费配音须另有预算授权");
        await directorTx(scope,client=>directorEvent(client,scope,input.projectId,"video.director.voice.dispatched",{jobId,shotId:clip.shotId,
          textHash:directorHash(clip.dialogue),sourceKind:"tts",revision:input.revision},{id:"video-director",type:"system"}));
        const spoken=await voice.speak({text:clip.dialogue,out,normalize:true,verify:true},{env,bins,config});
        if(spoken.result.duration_sec>clip.durationSec+.05) throw new DirectorJobError("DIALOGUE_WINDOW_OVERFLOW","完整旁白超过源镜头时长，需要调整文字或单独留出画面，不能截断台词");
        source={status:"ready",path:out,sourceKind:"tts",inSec:0,offsetSec:0,durationSec:spoken.result.duration_sec,jobId};
      } else if(role==="ambience" && description.trim() && !/^(无|none|静默|不适用)$/iu.test(description)) {
        await measure.runBin(bins.ffmpeg,["-hide_banner","-v","error","-n","-f","lavfi","-i",`anoisesrc=color=pink:seed=20261002:duration=${clip.durationSec}:sample_rate=48000`,
          "-af","lowpass=f=1800,highpass=f=80,volume=-42dB,afade=t=in:d=0.15","-ar","48000","-ac","2","-c:a","pcm_f32le",out],{label:"director(synthesized-ambience)"});
        source={status:"ready",path:out,sourceKind:"synthesized_ambience",inSec:0,offsetSec:0,durationSec:clip.durationSec,jobId};
      } else if(role==="foley" && description.trim() && !/^(无|none|静默|不适用)$/iu.test(description)) {
        const sfx=buildSfxArgs({kind:clip.role==="action"?"whoosh":"impact",durationSec:.26,peakDb:-24});
        await measure.runBin(bins.ffmpeg,["-hide_banner","-v","error","-n",...sfx,out],{label:"director(synthesized-foley)"});
        source={status:"ready",path:out,sourceKind:"synthesized_foley",inSec:0,offsetSec:0,durationSec:.26,jobId};
      } else source={status:"not_applicable",reason:role==="music"?"配乐只在逐版后期混入，不属于共享节目轨":role==="dialogue"?"此镜头没有人声":`${role} 在本次声音设计中不适用`,jobId};
      if(source.status==="ready") source.sha256=await sha256File(String(source.path));
      audio[role]=source;
    }
    shots.push({shotId:clip.shotId,videoSha256:clip.sha256,sourceDurationSec:clip.durationSec,durationSec:clip.durationSec,stems:audio});
  }
  const bindings=stems.describeAudioStemSources({scope:audioScope,shots,transitions:{mode:"hard"}});
  for(const item of bindings) {
    const binding=item.binding,shot=shots.find(s=>s.shotId===binding.shotId)!,source=shot.stems[binding.role];
    const evidence={issuer:"workloom.media-source-worker",status:"done",scope:audioScope,shotId:binding.shotId,role:binding.role,
      videoSha256:binding.videoSha256,bindingSha256:item.bindingSha256,
      ...(binding.status==="ready"?{outputPath:source.path,outputSha256:binding.sourceSha256,sourceKind:binding.sourceKind,
        productionMethod:binding.sourceKind==="tts"?"local-voice-engine":"deterministic-synthesis",description:input.filmPlan.shots.find(s=>s.shotId===binding.shotId)?.audio??null}
        :{decision:"not_applicable",reason:binding.reason})};
    await directorTx(scope,async client=>{
      const event=await directorEvent(client,scope,input.projectId,"video.director.audio.completed",{jobId:source.jobId,bindingSha256:item.bindingSha256,
        evidenceHash:directorHash(evidence)},{id:"workloom.media-source-worker",type:"system"});
      await client.query(`INSERT INTO video_director_audio_sources(id,tenant_id,workspace_id,project_id,revision,shot_id,role,binding_sha256,source_event_id,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[source.jobId,scope.tenantId,scope.workspaceId,input.projectId,input.revision,binding.shotId,binding.role,item.bindingSha256,event.eventId,evidence]);
    });
  }
  const signed=await authority.issueAudioSourceReceipts({scope:audioScope,shots,env,bins,readEvidence:async(id:string)=>
    directorTx(scope,async client=>(await client.query<{payload:unknown}>(`SELECT a.payload FROM video_director_audio_sources a JOIN biz_events e
      ON e.tenant_id=a.tenant_id AND e.workspace_id=a.workspace_id AND e.event_id=a.source_event_id WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.id=$3
      AND e.payload->'who'->>'id'='workloom.media-source-worker' AND e.payload->'decision'->>'action'='video.director.audio.completed'`,
      [scope.tenantId,scope.workspaceId,id])).rows[0]?.payload??null)});
  return input.clips.map(clip=>({...clip,audioStems:signed.find((s:any)=>s.shotId===clip.shotId).stems}));
}
/** Library URLs are issued only after re-reading scoped, content-addressed artifacts. */
export async function registerDirectorVariants(scope:CreativeScope,projectId:string,result:any,by:string) {
  const variants=[];
  for(const variant of result.variants??[]) {
    if(variant.status!=="complete"){variants.push({id:variant.id,label:variant.name,status:variant.status,error:variant.message});continue;}
    const film=variant.burned??variant.video;
    const video=await registerLocalAsset(getAppPool(),getGatewayPool(),scope,{absPath:film.path,expectedSha256:film.sha256,kind:"final_cut",
      projectId,by,title:`${projectId} · ${variant.label}`,pipelineKind:"narrative",meta:{directorVariantId:variant.id,directorRevision:result.revision},
      provenance:{composedFrom:"director-v2",planHash:variant.plan.planHash,sourceGenerationCalls:0},thumbnail:false,probe:true});
    const cover=await registerLocalAsset(getAppPool(),getGatewayPool(),scope,{absPath:variant.cover.path,expectedSha256:variant.cover.sha256,kind:"cover",
      projectId,by,title:`${projectId} · ${variant.label}封面`,thumbnail:false,probe:false});
    const copy=JSON.parse(await readFile(variant.copy.path,"utf8"));
    variants.push({id:variant.id,label:variant.label,platform:variant.platform,kind:variant.kind,status:"complete",recommended:variant.recommended,
      recommendationReason:variant.recommendationReason,videoAssetId:video.assetId,videoRelPath:video.relPath,coverAssetId:cover.assetId,coverRelPath:cover.relPath,
      durationSec:variant.video.duration,copy,personQc:variant.personQc,reusedLayers:variant.reusedLayers});
  }
  return variants;
}
export function publicDirectorVariants(variants:Array<Record<string,unknown>>) {
  return variants.map(v=>({id:v.id,label:v.label,platform:v.platform,kind:v.kind,status:v.status,error:v.error,
    recommended:v.recommended,recommendationReason:v.recommendationReason,durationSec:v.durationSec,copy:v.copy,reusedLayers:v.reusedLayers,
    videoAssetId:v.videoAssetId,coverAssetId:v.coverAssetId,
    personQc:v.personQc&&typeof v.personQc==="object"?{status:(v.personQc as any).status,
      samples:Array.isArray((v.personQc as any).samples)?(v.personQc as any).samples.length:0,
      temporalFramesCollected:(v.personQc as any).temporalFramesCollected===true,identityVerified:false,beautyImprovementVerified:false,
      limitation:(v.personQc as any).limitation}:null,
    videoUrl:typeof v.videoRelPath==="string"?mediaUrl(v.videoRelPath):null,
    coverUrl:typeof v.coverRelPath==="string"?mediaUrl(v.coverRelPath):null}));
}
export function publicDirectorDifference(value:unknown) {
  if(!value||typeof value!=="object") return null;
  const report=value as Record<string,any>;
  return {approved:report.approved===true,errors:Array.isArray(report.errors)?report.errors:[],basis:report.basis??null,
    pairs:(Array.isArray(report.pairs)?report.pairs:[]).map((p:any)=>({a:p.a,b:p.b,structural:p.structural===true,axes:p.axes,distinct:p.distinct===true})),
    humanAestheticReview:report.humanAestheticReview??"not_run"};
}
