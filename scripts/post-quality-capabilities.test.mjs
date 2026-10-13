import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deliveryQuality } from '../bundles/geo-growth/capabilities/post-quality.mjs';
import { assembleTimeline, normaliseShots, resolveBinaries } from '../bundles/ai-video/connectors/post-bridge/core.mjs';
import { captureProcessingInputs, writeProcessingProof } from '../bundles/ai-video/connectors/post-bridge/quality-gate.mjs';
import { loadCatalog, invokeCapability, mcpTools } from './agent-capabilities.mjs';
const REPO = path.resolve(import.meta.dirname, '..');
const bins = resolveBinaries();
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const envNames = ['WORKLOOM_VIDEO_ARTIFACT_ROOT','WORKLOOM_POST_FFMPEG_PATH','WORKLOOM_POST_FFPROBE_PATH'];
const mediaAvailable = (() => { try { execFileSync(bins.ffmpeg,['-version'],{stdio:'ignore'});execFileSync(bins.ffprobe,['-version'],{stdio:'ignore'});return true; }catch{return false;} })();
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'外部后期 质检-')));
  const old = Object.fromEntries(envNames.map(name=>[name,process.env[name]]));
  process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT=root;
  process.env.WORKLOOM_POST_FFMPEG_PATH=bins.ffmpeg;process.env.WORKLOOM_POST_FFPROBE_PATH=bins.ffprobe;
  t.after(()=>{for(const name of envNames){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}fs.rmSync(root,{recursive:true,force:true});});
  return root;
}
async function actualPost(t) {
  const root=setup(t), folder=path.join(root,'delivery');fs.mkdirSync(folder);
  const source=path.join(folder,'source.mp4');
  execFileSync(bins.ffmpeg,['-hide_banner','-v','error','-n','-f','lavfi','-i','testsrc2=s=160x90:r=30:d=0.5',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=0.5','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
  const normalized=await normaliseShots({project:{resolution:[160,90],fps:30},shots:[{shotId:'S1',path:source}],workDir:path.join(folder,'work'),bins});
  const inputs=await captureProcessingInputs([normalized[0].path]),processing=[];
  for(const id of ['master','fixture']) {
    const output=path.join(folder,`${id}.mp4`);
    await assembleTimeline({clips:normalized,output,resolution:[160,90],fps:30,transitions:{mode:'hard'},bins});
    processing.push(await writeProcessingProof({root:folder,stage:'transitions',id,inputs,outputs:[{path:output}],
      parameters:{request:{mode:'hard'},mode:'hard'},execution:{shotCount:1,cuts:[]}}));
  }
  const cover=path.join(folder,'cover.png');execFileSync(bins.ffmpeg,['-v','error','-n','-i',path.join(folder,'fixture.mp4'),'-frames:v','1','-update','1',cover]);
  const media=name=>({path:`${name}.mp4`,sha256:digest(path.join(folder,`${name}.mp4`)),duration:0.5});
  const manifest={schemaVersion:'workloom.delivery-package/v1',projectId:'P1',deliveryRoot:'.',resolution:[160,90],nativeResolution:[160,90],fps:30,
    postRequirements:{variantIds:['fixture'],subtitles:false,burnSubtitles:false,softSubtitles:false,danmaku:false},processing,
    master:media('master'),transitions:{request:{mode:'hard'}},variants:[{id:'fixture',style:{bgm:{enabled:false},transitions:{mode:'hard'}},
      video:media('fixture'),cover:{path:'cover.png',sha256:digest(cover)}}],postQuality:{passed:true}};
  const manifestFile=path.join(folder,'delivery-manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  return {root,folder,manifest,manifestFile,source};
}

test('external quality discovery is readonly and invalid inputs cannot escape its artifact root',async t=>{
  const root=setup(t);fs.mkdirSync(path.join(root,'empty'));
  const catalog=await loadCatalog(REPO),descriptor=catalog.entries.get('growth.video.post.quality');
  assert.equal(descriptor.operation,'read');assert.equal(descriptor.risk,'low');assert.equal(descriptor.transport.module,'bundles/geo-growth/capabilities/post-quality.mjs');
  const tool=mcpTools(catalog).find(row=>row.name==='workloom_growth_video_post_quality');assert.equal(tool.annotations.readOnlyHint,true);
  assert.equal((await deliveryQuality({outDir:'empty'})).complete,false);
  for(const input of [{outDir:'../escape'},{outDir:'/tmp'},{kind:'fake'},{path:'private'},[]])await assert.rejects(deliveryQuality(input));
  fs.writeFileSync(path.join(root,'private'),'private');fs.symlinkSync(os.tmpdir(),path.join(root,'escape'));
  await assert.rejects(deliveryQuality({outDir:'escape'}),/越出/u);
});

test('actual CLI and MCP re-inspect media: pass, tamper, fail, restore, pass; revision roots bind identity', {skip:!mediaAvailable,timeout:150000},async t=>{
  const f=await actualPost(t),input={projectId:'P1',outDir:'delivery',kind:'post'},catalog=await loadCatalog(REPO);
  const sourceHash=digest(f.source),manifestHash=digest(f.manifestFile);
  const current=await deliveryQuality(input);assert.equal(current.complete,true,JSON.stringify({failures:current.report.checks.filter(row=>row.hard&&!row.ok),assets:current.report.assets.filter(row=>row.media==='video').map(row=>row.probe)}));
  assert.equal(current.paidCalls,0);assert.equal(current.artisticQuality,'unverified');assert.ok(current.report.assets.filter(row=>row.media==='video').every(row=>row.decoded));
  const cli=()=>spawnSync(process.execPath,[path.join(REPO,'scripts/workloom-agent.mjs'),'invoke','growth.video.post.quality','--input-file','-'],{cwd:os.tmpdir(),input:JSON.stringify(input),encoding:'utf8',env:process.env});
  const success=cli();assert.equal(success.status,0,success.stderr);assert.equal(JSON.parse(success.stdout).result.complete,true);
  const asset=path.join(f.folder,'fixture.mp4'),bytes=fs.readFileSync(asset);fs.writeFileSync(asset,'changed bytes');
  const failed=await invokeCapability(catalog,'growth.video.post.quality',input);assert.equal(failed.result.complete,false);assert.equal(failed.result.technicalQuality,'failed');
  fs.writeFileSync(asset,bytes);assert.equal((await deliveryQuality(input)).complete,true);
  const revisions=path.join(f.folder,'versions','v2');fs.mkdirSync(revisions,{recursive:true});
  fs.writeFileSync(path.join(revisions,'delivery-manifest.json'),JSON.stringify({...f.manifest,version:2,deliveryRoot:'../..'}));
  assert.equal((await deliveryQuality({...input,outDir:'delivery/versions/v2'})).complete,true);
  const calls=[{method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'post-quality-fixture',version:'1'}}},
    {method:'tools/list',params:{}},{method:'tools/call',params:{name:'workloom_growth_video_post_quality',arguments:input}}];
  const mcp=spawnSync(process.execPath,[path.join(REPO,'scripts/workloom-agent-mcp.mjs')],{cwd:os.tmpdir(),encoding:'utf8',env:{...process.env,WORKLOOM_PRODUCT_ROOT:REPO},
    input:calls.map((row,index)=>JSON.stringify({jsonrpc:'2.0',id:index+1,...row})).join('\n')+'\n'});
  assert.equal(mcp.status,0,mcp.stderr);const replies=mcp.stdout.trim().split('\n').map(JSON.parse);
  assert.ok(replies.find(row=>row.id===2).result.tools.some(row=>row.name==='workloom_growth_video_post_quality'));
  assert.equal(JSON.parse(replies.find(row=>row.id===3).result.content[0].text).result.complete,true);
  assert.equal(digest(f.source),sourceHash);assert.equal(digest(f.manifestFile),manifestHash);
});

test('external generation acceptance reads the current HD/UHD release and rejects byte changes, missing proof and forged pointers', {skip:!mediaAvailable,timeout:120000},async t=>{
  const root=setup(t),publicRoot=path.join(root,'generation'),releaseId='actual-media-fixture',release=path.join(publicRoot,'releases',releaseId);
  fs.mkdirSync(release,{recursive:true});
  const source=path.join(root,'generation-source.mp4');
  execFileSync(bins.ffmpeg,['-hide_banner','-v','error','-n','-f','lavfi','-i','testsrc2=s=160x90:r=30:d=0.5',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=0.5','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
  const {createGenerationQuality}=await import('./tools/generation-quality.mjs');
  const quality=createGenerationQuality({root:release,bins});quality.preserveSource(source,'S1');
  const master=path.join(release,'master.mp4'),composer=path.join(REPO,'scripts/tools/compose-film.mts'),args=['--clips',source,'--out',master,'--width','160','--height','90','--fps','30','--fade','0','--color','none'];
  const token=quality.beginCli(composer,args);
  const composed=spawnSync(process.execPath,['--import','tsx',composer,...args],{cwd:REPO,encoding:'utf8',env:process.env,timeout:60000,maxBuffer:8*1024*1024});
  assert.equal(composed.status,0,composed.stderr||composed.stdout);
  const receiptFile=master.replace(/\.mp4$/,'.av-sync.json');quality.finishCli(token,{report:JSON.parse(fs.readFileSync(receiptFile)),receiptFile});
  const requirements=['cover','bgm','subtitles','danmaku','transitions','color','resolution'].map(name=>['transitions','resolution'].includes(name)?{name,requirement:'required'}:
    {name,requirement:'not_applicable',reason:'This actual external fixture requests composition and native master only.'});
  const accepted=await quality.inspect({phase:'external-fixture',scope:'master',artifacts:[{id:'master',path:master,media:'video',requiredStages:['transitions'],fps:30,durationSeconds:0.5}],
    requirements,resolution:[160,90],sourceResolution:[160,90],variantIds:[],requiredOutputIds:['master']});
  assert.equal(accepted.report.passed,true);
  const manifestFile=path.join(release,'P-GEN-delivery-manifest.json'),manifest={projectId:'P-GEN',scope:'master',variants:[],generationQuality:accepted.manifest};
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const pointerFile=path.join(publicRoot,'current.json'),writePointer=()=>fs.writeFileSync(pointerFile,JSON.stringify({schemaVersion:'workloom.uhd-release/v1',releaseId,releaseDir:release,manifest:manifestFile,manifestSha256:digest(manifestFile)}));
  writePointer();const pointerBytes=fs.readFileSync(pointerFile),manifestBytes=fs.readFileSync(manifestFile),sourceHash=digest(source),input={projectId:'P-GEN',outDir:'generation',kind:'generation'};
  const pass=await deliveryQuality(input);assert.equal(pass.complete,true,JSON.stringify(pass.report.checks.filter(row=>row.hard&&!row.ok)));assert.equal(pass.inspectionKind,'generation');
  assert.equal(pass.paidCalls,0);assert.equal(pass.artisticQuality,'unverified');assert.equal(pass.report.generationQuality.currentFileInspection,true);
  const bytes=fs.readFileSync(master);fs.writeFileSync(master,'changed master');assert.equal((await deliveryQuality(input)).complete,false);
  fs.writeFileSync(master,bytes);assert.equal((await deliveryQuality(input)).complete,true);
  fs.writeFileSync(manifestFile,JSON.stringify({...manifest,generationQuality:{...manifest.generationQuality,processing:[]},postQuality:{passed:true}}));writePointer();
  assert.equal((await deliveryQuality(input)).complete,false);fs.writeFileSync(manifestFile,manifestBytes);writePointer();assert.equal((await deliveryQuality(input)).complete,true);
  const pointer=JSON.parse(pointerBytes);fs.writeFileSync(pointerFile,JSON.stringify({...pointer,manifestSha256:'a'.repeat(64)}));await assert.rejects(deliveryQuality(input),/指针与当前清单不一致/u);
  fs.writeFileSync(pointerFile,JSON.stringify({...pointer,releaseDir:root}));await assert.rejects(deliveryQuality(input),/指针与当前清单不一致/u);
  fs.writeFileSync(pointerFile,pointerBytes);assert.equal((await deliveryQuality(input)).complete,true);
  fs.copyFileSync(manifestFile,path.join(root,'legacy-delivery-manifest.json'));fs.writeFileSync(path.join(root,'legacy-delivery-manifest.json'),JSON.stringify({projectId:'P-OLD',postQuality:{passed:true}}));
  assert.equal((await deliveryQuality({projectId:'P-OLD',outDir:'.',kind:'generation'})).complete,false);
  assert.equal(digest(source),sourceHash);assert.deepEqual(fs.readFileSync(pointerFile),pointerBytes);assert.deepEqual(fs.readFileSync(manifestFile),manifestBytes);
});
