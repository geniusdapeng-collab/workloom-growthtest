/** Local synthetic integration regression: four versions, incremental revisions and fail-closed media evidence. Never submits image/video API requests. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const repo=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);const option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
if(args.some((arg,i)=>i%2===0&&!['--work-dir','--ffmpeg','--ffprobe'].includes(arg))||args.length%2)throw new Error('Usage: node scripts/test-director-local-media.mjs --work-dir <isolated-dir> --ffmpeg <verified-bin> --ffprobe <verified-bin>');
if(!option('--work-dir')||!option('--ffmpeg')||!option('--ffprobe'))throw new Error('Explicit isolated work directory and verified media binary paths are required; no image/video API is used');
const {runBin,sha256File}=await import(path.join(repo,'bundles/ai-video/connectors/subtitle-bridge/measure.mjs'));
const {describeAudioStemSources}=await import(path.join(repo,'bundles/ai-video/connectors/bgm-bridge/audio-stems.mjs'));
const {issueAudioSourceReceipts}=await import(path.join(repo,'bundles/ai-video/library/director-system/audio-authority.mjs'));
const {directorHash}=await import(path.join(repo,'bundles/ai-video/library/director-system/core.mjs'));
const {buildDirectorDelivery,reviseDirectorDelivery}=await import(path.join(repo,'bundles/ai-video/connectors/post-bridge/director-delivery.mjs'));
const root=path.resolve(option('--work-dir'));
if(root===repo||repo.startsWith(root+path.sep))throw new Error('Fixture directory cannot be the repository or its parent');
await fs.mkdir(root,{recursive:true});
const bins={ffmpeg:path.resolve(option('--ffmpeg')),ffprobe:path.resolve(option('--ffprobe'))};
const env={...process.env,WL_TSX_PATH:path.join(root,"unavailable-native-entity-adapter"),WORKLOOM_BGM_DISCOVER:"0",WORKLOOM_BGM_HOME:path.join(root,"absent-music"),WORKLOOM_AUDIO_STEM_SIGNING_SECRET:randomBytes(32).toString('hex'),WORKLOOM_POST_ALLOWED_ROOTS:JSON.stringify([root,repo]),WORKLOOM_BGM_ALLOWED_ROOTS:JSON.stringify([root,repo]),WORKLOOM_COLOR_ALLOWED_ROOTS:JSON.stringify([root,repo]),WORKLOOM_SUBTITLE_ALLOWED_ROOTS:JSON.stringify([root,repo])};
const scope={tenantId:'fixture-tenant',workspaceId:'fixture-workspace',projectId:'fixture-film',revision:1};
const roles=['establishing','hero','action','detail','resolution'];let shots=[];
for(let i=0;i<roles.length;i++){
 const video=path.join(root,`SC-${i+1}.mp4`),audio=path.join(root,`SC-${i+1}.wav`),ambience=path.join(root,`SC-${i+1}-ambience.wav`);
 await runBin(bins.ffmpeg,['-hide_banner','-v','error','-y','-f','lavfi','-i',`testsrc2=s=320x568:r=30:d=2.4`,'-vf',`hue=h=${i*35}`,'-an','-c:v','libx264','-threads','2','-pix_fmt','yuv420p',video]);
 await runBin(bins.ffmpeg,['-hide_banner','-v','error','-y','-f','lavfi','-i',`sine=frequency=${200+i*130}:duration=2.4`,'-ar','48000','-ac','2','-c:a','pcm_f32le',audio]);
 await runBin(bins.ffmpeg,['-hide_banner','-v','error','-y','-f','lavfi','-i',`anoisesrc=color=pink:seed=${i+1}:duration=2.4:sample_rate=48000`,'-ar','48000','-ac','2','-c:a','pcm_f32le',ambience]);
 const audioHash=await sha256File(audio),ambienceHash=await sha256File(ambience);
 const stems=Object.fromEntries(['dialogue','ambience','foley','music'].map(role=>[role,(role==='ambience'||role==='dialogue'&&i===1)?{status:'ready',sourceKind:role==='ambience'?'synthesized_ambience':'isolated_recording',path:role==='ambience'?ambience:audio,sha256:role==='ambience'?ambienceHash:audioHash,durationSec:2.4,jobId:`job-${i}-${role}`}:{status:'not_applicable',reason:'Synthetic fixture has no '+role,jobId:`job-${i}-${role}`} ]));
 shots.push({shotId:`SC-${i+1}`,path:video,role:roles[i],dialogue:i===1?'这是合成素材回归字幕':'',videoSha256:await sha256File(video),durationSec:2.4,stems});
}
const evidence=new Map();for(const {binding,bindingSha256} of describeAudioStemSources({scope,shots})){
 const s=shots.find(x=>x.shotId===binding.shotId).stems[binding.role];evidence.set(s.jobId,{status:'done',issuer:'workloom.media-source-worker',scope,shotId:binding.shotId,role:binding.role,videoSha256:binding.videoSha256,bindingSha256,decision:s.status,reason:s.reason,outputPath:s.path,outputSha256:s.sha256,sourceKind:s.sourceKind});
}
shots=await issueAudioSourceReceipts({scope,shots,readEvidence:async(id)=>evidence.get(id),env,bins});
shots=shots.map(s=>({...s,audioStems:s.stems}));
const output=path.join(root,`delivery-${Date.now()}`);
const result=await buildDirectorDelivery({project:{projectId:scope.projectId,audioScope:scope,title:'共享素材四版本',intent:'民宿的晨光，精致电影感',creativeMode:'director_auto',resolution:[320,568],fps:30,personRegions:[{sourceId:'SC-2',x:.25,y:.1,width:.5,height:.6,origin:'human-registered'}]},shots,subtitles:{zhCues:[{startSec:2.55,endSec:4.3,text:'这是合成素材回归字幕'}]},outDir:output,bins,env,softSubtitles:true,burnSubtitles:true});
await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));
const summaries=[];
function summary(r){return {status:r.status,failures:r.failures,technicalPassed:r.postQuality?.passed,differenceReviewed:r.difference?.status,artisticQualityReviewed:r.qualityReport?.artisticQualityReviewed,versions:r.variants.map(v=>({id:v.id,status:v.status,durationFrames:v.actual?.durationFrames,burned:Boolean(v.burned),softsub:Boolean(v.softsub),personQualityReviewed:v.personQc?.status,entityApplied:v.entity?.receipt?.applied,music:v.audio?.music?.license,reusedLayers:v.reusedLayers}))};}
const first=summary(result);summaries.push({operation:'create',...first});
if(result.status!=='complete') {console.log(JSON.stringify({output,...first}));process.exit(1);}
if(!result.postQuality?.passed||result.qualityReport?.stages.length!==7||result.qualityReport?.artisticQualityReviewed!==false||result.variants.some(v=>v.personQc.status!=='not-reviewed'))throw new Error('real technical quality or explicit artistic boundary missing');
const cached=await buildDirectorDelivery({project:JSON.parse(await fs.readFile(result.projectPath,'utf8')).project,shots,subtitles:{zhCues:[{startSec:2.55,endSec:4.3,text:'这是合成素材回归字幕'}]},outDir:output,bins,env,softSubtitles:true,burnSubtitles:true});
if(!cached.reused)throw new Error('cache was not reused');
const id=result.variants[0].id;
const revise=async(previous,feedback,key)=>reviseDirectorDelivery({projectPath:previous.projectPath,expectedVersion:previous.revision,expectedProjectSha256:await sha256File(previous.projectPath),feedback,variantId:id,idempotencyKey:key,bins,env});
const audio=await revise(result,'第一版配乐轻一点','fixture-audio');summaries.push({operation:'audio',...summary(audio)});
if(audio.status!=='complete'||!audio.variants[0].reusedLayers.picture||!audio.variants[0].reusedLayers.color||audio.variants[0].reusedLayers.audio)throw new Error('audio layer reuse incorrect');
const cover=await revise(audio,'第一版封面简洁一点','fixture-cover');summaries.push({operation:'cover',...summary(cover)});
if(cover.status!=='complete'||!cover.variants[0].reusedVideo||!cover.variants[0].reusedLayers.subtitles||cover.variants[0].personQc.status!=='not-reviewed')throw new Error('cover layer reuse or unreviewed person state incorrect');
const timeline=await revise(cover,'第一版第三镜太快，多留一点','fixture-timeline');summaries.push({operation:'timeline',...summary(timeline)});
if(timeline.status!=='complete'||timeline.variants[0].reusedLayers.picture)throw new Error('timeline feedback did not execute');
const replay=await revise(cover,'第一版第三镜太快，多留一点','fixture-timeline');if(!replay.idempotentReplay)throw new Error('replay failed');
let conflict=false;try{await revise(cover,'第一版配乐轻一点','fixture-stale');}catch(e){conflict=e.code==='REVISION_CONFLICT';}if(!conflict)throw new Error('stale CAS was accepted');
let mismatch=false;try{await revise(cover,'第一版封面简洁一点','fixture-timeline');}catch(e){mismatch=e.code==='IDEMPOTENCY_MISMATCH';}if(!mismatch)throw new Error('idempotency mismatch was accepted');
const newContent=await revise(timeline,'第三镜换成雪山，主角跑起来','fixture-new-shot');if(newContent.status!=='requires-generation-plan'||newContent.renderApiCalls!==0)throw new Error('new source was submitted without approval');
const concurrency=await Promise.allSettled([revise(timeline,'第一版封面简洁一点','fixture-race-a'),revise(timeline,'第一版封面简洁一点','fixture-race-b')]);
if(concurrency.filter(r=>r.status==='fulfilled').length!==1||concurrency.filter(r=>r.status==='rejected'&&r.reason.code==='REVISION_CONFLICT').length!==1)throw new Error('concurrent writers were not excluded');
const current=concurrency.find(r=>r.status==='fulfilled').value;
const video=current.variants[0].video.path,bytes=await fs.readFile(video);await fs.appendFile(video,'tamper');
let tamper=false;try{await revise(current,'封面简洁一点','fixture-tamper');}catch(e){tamper=e.code==='SOURCE_CHANGED';}finally{await fs.writeFile(video,bytes);}if(!tamper)throw new Error('changed source was accepted');
const frozen=JSON.parse(await fs.readFile(current.projectPath,'utf8'));
const missingMusicPlans=structuredClone(frozen.plans);delete missingMusicPlans[0].planHash;
missingMusicPlans[0].musicPlan={...missingMusicPlans[0].musicPlan,trackId:'fixture-missing-licensed-track'};
missingMusicPlans[0].planHash=directorHash(missingMusicPlans[0]);
const missingMusic=await buildDirectorDelivery({project:{...frozen.project,revision:frozen.version+1},shots:frozen.shots,subtitles:frozen.subtitles,
 targetPlan:frozen.targetPlan,plannedVariants:missingMusicPlans,preparedSources:frozen.prepared,previousVariants:frozen.variants,
 impactLayers:Object.fromEntries(frozen.variants.map((v,i)=>[v.id,i===0?['audio']:[]])),
 softSubtitles:frozen.softSubtitles,burnSubtitles:frozen.burnSubtitles,outDir:path.join(frozen.revisionRoot,'revisions',`v${frozen.version+1}`),bins,env});
if(missingMusic.status!=='partial'||missingMusic.failures.length!==1||missingMusic.failures[0].code!=='not_found'||missingMusic.variants.filter(v=>v.status==='complete').length!==3)throw new Error('missing licensed track was silently replaced');
summaries.push({operation:'missing-licensed-music',status:missingMusic.status,failedVersion:missingMusic.failures[0].id,failureCode:missingMusic.failures[0].code,otherVersions:3,implicitScore:false});
const receipt={dataMode:'local-synthetic-ffmpeg',output,renderApiCalls:0,imageApiCalls:0,beautyImprovement:'not-tested',summaries,checks:{cache:true,sequentialRevisions:true,idempotentReplay:true,staleCasRejected:conflict,idempotencyMismatchRejected:mismatch,newRenderRequiresApproval:true,concurrentWritersExcluded:true,tamperRejected:tamper,missingMusicFailsWithoutImplicitSynthesis:true}};
await fs.writeFile(path.join(root,'verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
