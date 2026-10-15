import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { createGenerationQuality, generationFileSha256, inspectGenerationManifest } from './generation-quality.mjs';
import { publishUhdDelivery } from '../../packages/video-studio/src/uhd-delivery.ts';
const REPO = path.resolve(import.meta.dirname, '../..');
const bins = { ffmpeg: process.env.WL_FFMPEG || 'ffmpeg', ffprobe: process.env.WL_FFPROBE || 'ffprobe' };
const execute = (file, args) => { const result = spawnSync(file, args, { cwd: REPO, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, WL_FFMPEG: bins.ffmpeg, WL_FFPROBE: bins.ffprobe, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` } });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error)); return result.stdout; };
const requirements = ['cover','bgm','subtitles','danmaku','transitions','color','resolution'].map(name => ['transitions','resolution'].includes(name)
  ? { name, requirement: 'required' } : { name, requirement: 'not_applicable', reason: 'This media fixture requests only actual composition and native export.' });
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

async function actualFixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'generation quality 中文 空格-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'candidate'), sources = ['source-a.mp4','source-b.mp4'].map(name => path.join(home,name));
  mkdirSync(root);
  for (const [index,file] of sources.entries()) execute(bins.ffmpeg, ['-v','error','-nostdin','-y','-f','lavfi','-i',`testsrc2=s=160x90:r=30:d=0.5`,
    '-f','lavfi','-i',`sine=frequency=${440 + index * 440}:sample_rate=48000:duration=0.5`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',file]);
  const sourceHashes = sources.map(generationFileSha256), quality = createGenerationQuality({ root, bins });
  sources.forEach((file,index) => quality.preserveSource(file, `S${index + 1}`));
  const output = path.join(root, 'master.mp4'), cli = path.join(REPO, 'scripts/tools/compose-film.mts');
  const args = ['--clips',sources.join(','),'--out',output,'--width','160','--height','90','--fps','30','--fade','0','--color','none'];
  const token = quality.beginCli(cli,args); execute(process.execPath,['--import','tsx',cli,...args]);
  const receiptFile = output.replace(/\.mp4$/,'.av-sync.json'), receipt = JSON.parse(readFileSync(receiptFile));
  quality.finishCli(token,{report:receipt,receiptFile});
  const accepted = await quality.inspect({ phase:'generation-fixture',scope:'master', artifacts:[{ id:'master',path:output,media:'video',requiredStages:['transitions'],fps:30,durationSeconds:1 }],
    requirements,resolution:[160,90],sourceResolution:[160,90],variantIds:[],requiredOutputIds:['master'] });
  assert.equal(accepted.report.passed,true,JSON.stringify(accepted.report.checks.filter(row => row.hard && !row.ok)));
  assert.deepEqual(sources.map(generationFileSha256),sourceHashes);
  return {home,root,sources,sourceHashes,quality,output,accepted};
}

test('real composition lifecycle, negative contracts and immutable current pointer', {timeout:150000}, async t => {
  const f=await actualFixture(t), manifest={generationQuality:f.accepted.manifest};
  await t.test('actual native output and every original source are independently re-read',async()=>{
    const result=await inspectGenerationManifest({root:f.root,manifest,bins,phase:'independent'});
    assert.equal(result.passed,true); assert.ok(result.assets.filter(row=>row.media==='video').every(row=>row.decoded));
    assert.equal(result.generationQuality.sourceCount,2);assert.equal(result.generationQuality.currentFileInspection,true);
    assert.equal(result.artisticQualityReviewed,false); assert.equal(result.paidCalls,0);
  });
  for(const [label,expected] of [['fps',{fps:60,durationSeconds:1}],['duration',{fps:30,durationSeconds:2}]])
    await t.test(`initial lifecycle inspection rejects a declared ${label} that differs from actual video`,async()=>{
      await assert.rejects(f.quality.inspect({phase:`invalid-declared-${label}`,scope:'master',
        artifacts:[{id:'master',path:f.output,media:'video',requiredStages:['transitions'],...expected}],
        requirements,resolution:[160,90],sourceResolution:[160,90],variantIds:[]}),
        error=>error.code==='post_quality_failed'&&error.report?.checks.some(row=>row.kind==='asset:master'&&row.ok===false));
    });
  for(const [name,change,check] of [
    ['missing actual proof',value=>value.processing=[],/stage:transitions|actual-composition|chain/],
    ['missing final form',value=>value.artifacts=[],/required-final-forms/],
    ['missing requested soft subtitle',value=>value.requiredOutputIds.push('softsub'),/required-final-forms/],
    ['missing requested cover',value=>value.requiredOutputIds.push('cover:master'),/required-final-forms/],
    ['native per-axis downscale',value=>value.sourceResolution=[320,90],/native-resolution/],
    ['wrong actual geometry',value=>value.artifacts[0].resolution=[320,180],/asset:master/],
    ['wrong actual fps',value=>value.artifacts[0].fps=60,/asset:master/],
    ['requested BGM cannot borrow another stage',value=>value.artifacts[0].requiredStages.push('bgm'),/chain:master:bgm/],
    ['requested color recipe cannot borrow a passed boolean',value=>value.artifacts[0].expectedColorProfile='warm-story',/chain:master:color-profile/],
    ['missing source identities',value=>value.sources=[],/original-sources-present|source-identities-unique/],
  ])await t.test(name,async()=>{const value=structuredClone(f.accepted.manifest);change(value);const result=await inspectGenerationManifest({root:f.root,manifest:{generationQuality:value},bins});
    assert.equal(result.passed,false);assert.ok(result.checks.some(row=>row.hard&&!row.ok&&check.test(row.kind)),JSON.stringify(result.checks));});
  await t.test('a source changed after begin cannot create a completion receipt',()=>{
    const temp=path.join(f.home,'mutable-source.json'), output=path.join(f.root,'current-output.json');writeFileSync(temp,'{"before":true}');writeFileSync(output,'{"actual":true}');
    const token=f.quality.begin('resolution','mutation',[temp],{mode:'copy'});writeFileSync(temp,'{"after":true}');
    assert.throws(()=>f.quality.finish(token,{outputs:[output],execution:{exitCode:0}}),/修改来源/);f.quality.abort(token);
  });
  await t.test('begin token cannot be invented or consumed twice',()=>{
    assert.throws(()=>f.quality.finish({token:'invented'},{outputs:[f.output],execution:{exitCode:0}}),/缺调用前凭证/);
  });
  await t.test('source originals cannot be changed between processing and final inspection',async()=>{
    const bytes=readFileSync(f.sources[0]);writeFileSync(f.sources[0],'changed original');
    try{await assert.rejects(f.quality.inspect({phase:'bad',scope:'master',artifacts:[{id:'master',path:f.output,media:'video'}],requirements,resolution:[160,90],sourceResolution:[160,90]}),/原片在加工后发生变化/);}
    finally{writeFileSync(f.sources[0],bytes);}assert.deepEqual(f.sources.map(generationFileSha256),f.sourceHashes);
  });
  await t.test('a type-less unrelated JSON file cannot mint processing completion',async()=>{
    const bad=path.join(f.root,'fake.json');writeFileSync(bad,JSON.stringify({passed:true,stage:'transitions'}));const value=structuredClone(f.accepted.manifest);
    value.processing=[{path:'fake.json',sha256:generationFileSha256(bad),stage:'transitions',id:'fake',outputs:[]}];
    const result=await inspectGenerationManifest({root:f.root,manifest:{generationQuality:value},bins});assert.equal(result.passed,false);
  });
  await t.test('each real graded variant must consume its own requested color recipe',async()=>{
    const cli=path.join(REPO,'bundles/ai-video/connectors/color-bridge/cli.mjs'), variants=[];
    for(const [id,profile] of [['warm','warm-film'],['cool','cool-technical']]){
      const file=path.join(f.root,`${id}.mp4`),args=['grade','--in',f.output,'--out',file,'--profile',profile,'--intensity','0.6','--clarity','conservative','--quality-guard','report','--json'];
      const token=f.quality.beginCli(cli,args),report=JSON.parse(execute(process.execPath,[cli,...args]));
      f.quality.finishCli(token,{report});variants.push({id:`variant:${id}`,path:file,media:'video',fps:30,durationSeconds:1,requiredStages:['transitions','color'],expectedColorProfile:profile});
    }
    const accepted=await f.quality.inspect({phase:'actual-variant-colors',scope:'delivery',artifacts:[{id:'master',path:f.output,media:'video',fps:30,durationSeconds:1,requiredStages:['transitions']},...variants],
      requirements:requirements.map(row=>row.name==='color'?{name:'color',requirement:'required'}:row),resolution:[160,90],sourceResolution:[160,90],variantIds:['warm','cool']});
    assert.equal(accepted.report.passed,true);assert.notEqual(accepted.manifest.artifacts[1].sha256,accepted.manifest.artifacts[2].sha256);
    const wrong=structuredClone(accepted.manifest);wrong.artifacts[1].expectedColorProfile='cool-technical';
    const result=await inspectGenerationManifest({root:f.root,manifest:{generationQuality:wrong},bins});
    assert.equal(result.passed,false);assert.ok(result.checks.some(row=>row.kind.endsWith('chain:variant:warm:color-profile')&&row.ok===false),JSON.stringify(result.checks));
    assert.deepEqual(f.sources.map(generationFileSha256),f.sourceHashes);
  });
  await t.test('master-only publication copies proof snapshots, rechecks media and switches one current pointer',async()=>{
    const publicRoot=path.join(f.home,'public'),releaseId='first-actual-release',release=path.join(publicRoot,'releases',releaseId);
    const content=walk(f.root),manifestFile=path.join(f.root,'delivery.json');
    const value={scope:'master',variants:[],deliverable:{path:path.join(release,path.relative(f.root,f.output)),sha256:generationFileSha256(f.output)},
      assets:content.map(file=>({path:path.join(release,path.relative(f.root,file)),sha256:generationFileSha256(file)})),generationQuality:f.accepted.manifest,
      qualityReport:{path:path.relative(f.root,f.accepted.qualityFile.path),sha256:f.accepted.qualityFile.sha256}};
    writeFileSync(manifestFile,JSON.stringify(value));
    const published=await publishUhdDelivery({stagingDir:f.root,publicRoot,releaseId,assets:[...content,manifestFile].map(file=>path.relative(f.root,file)),
      manifestName:'delivery.json',approved:true,masterOnly:true,qualityRequired:true,bins});
    const pointer=readFileSync(published.currentFile);assert.equal(JSON.parse(pointer).releaseDir,release);
    const copy=await inspectGenerationManifest({root:release,manifest:JSON.parse(readFileSync(path.join(release,'delivery.json'))),bins});assert.equal(copy.passed,true);
    const second=path.join(f.home,'second-candidate');cpSync(f.root,second,{recursive:true});
    const next=JSON.parse(readFileSync(path.join(second,'delivery.json'))),nextRelease=path.join(publicRoot,'releases','rejected-release');
    next.assets=next.assets.map(row=>({...row,path:row.path.replace(release,nextRelease)}));next.deliverable.path=next.deliverable.path.replace(release,nextRelease);
    next.generationQuality.artifacts[0].fps=60;writeFileSync(path.join(second,'delivery.json'),JSON.stringify(next));
    await assert.rejects(publishUhdDelivery({stagingDir:second,publicRoot,releaseId:'rejected-release',assets:[...content,manifestFile].map(file=>path.relative(f.root,file)),
      manifestName:'delivery.json',approved:true,masterOnly:true,qualityRequired:true,bins}),/CURRENT_MEDIA_QUALITY_FAILED/);
    assert.deepEqual(readFileSync(published.currentFile),pointer);assert.equal(existsSync(nextRelease),false);assert.equal(existsSync(release),true);
  });
});

test('real trims and enhancements remain causal edges between original clips and final composition', {timeout:90000}, async t=>{
  const f=await actualFixture(t),derived=[];
  for(const [index,source] of f.sources.entries()){
    const file=path.join(f.root,`derived-${index}.mp4`),argv=['-v','error','-nostdin','-y','-i',source,'-t','0.3','-vf','scale=192:108','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',file];
    const token=f.quality.begin('resolution',`actual-trim-enhance-${index}`,[source],{mode:'trim-and-enhance',request:{argv}});
    execute(bins.ffmpeg,argv);f.quality.finish(token,{outputs:[file],execution:{argv,exitCode:0}});derived.push(file);
  }
  const output=path.join(f.root,'derived-master.mp4'),cli=path.join(REPO,'scripts/tools/compose-film.mts'),args=['--clips',derived.join(','),'--out',output,'--width','192','--height','108','--fps','30','--fade','0','--color','none'];
  const token=f.quality.beginCli(cli,args);execute(process.execPath,['--import','tsx',cli,...args]);
  const receiptFile=output.replace(/\.mp4$/,'.av-sync.json');f.quality.finishCli(token,{report:JSON.parse(readFileSync(receiptFile)),receiptFile});
  const accepted=await f.quality.inspect({phase:'actual-derived-composition',scope:'master',artifacts:[{id:'master',path:output,media:'video',fps:30,durationSeconds:0.6,requiredStages:['resolution','transitions']}],
    requirements,resolution:[192,108],sourceResolution:[160,90],variantIds:[]});
  assert.equal(accepted.report.passed,true);assert.deepEqual(f.sources.map(generationFileSha256),f.sourceHashes);
  const missing=structuredClone(accepted.manifest);missing.processing=missing.processing.filter(row=>row.id!=='actual-trim-enhance-0');
  const result=await inspectGenerationManifest({root:f.root,manifest:{generationQuality:missing},bins});
  assert.equal(result.passed,false);assert.ok(result.checks.some(row=>row.kind.endsWith('chain:master')&&row.ok===false),JSON.stringify(result.checks));
  for(const [label,mutate] of [
    ['schema',value=>value.schemaVersion='unrelated-resolution-json'],
    ['engine',value=>value.engine='caller-label'],
    ['request digest',value=>value.requestSha256='a'.repeat(64)],
    ['request parameters',value=>value.parameters.request.argv=['invented-operation']],
    ['input bytes',value=>value.inputs[0].sha256='b'.repeat(64)],
  ])await t.test(`derived resolution receipt rejects altered ${label} after its descriptor hash is refreshed`,async()=>{
    const value=structuredClone(accepted.manifest),proof=value.processing.find(row=>row.id==='actual-trim-enhance-0'),file=path.join(f.root,proof.path),before=readFileSync(file);
    try{const document=JSON.parse(before);mutate(document);writeFileSync(file,JSON.stringify(document));proof.sha256=generationFileSha256(file);
      const rejected=await inspectGenerationManifest({root:f.root,manifest:{generationQuality:value},bins});
      assert.equal(rejected.passed,false);assert.ok(rejected.checks.some(row=>row.kind==='processing:resolution-proof:actual-trim-enhance-0'&&row.ok===false),JSON.stringify(rejected.checks));
    }finally{writeFileSync(file,before);}
  });
});

test('AI variants preserve original bytes and prove two independent exact color operations', {timeout:150000}, async t => {
  const { buildVariantPlan } = await tsImport('../../packages/video-studio/src/deliver.ts', import.meta.url);
  const { copyFileSync } = await import('node:fs');
  const f = await actualFixture(t), sourceSha = generationFileSha256(f.output);
  const cli = path.join(REPO, 'bundles/ai-video/connectors/color-bridge/cli.mjs');
  const plans = buildVariantPlan({ master:f.output, outDir:f.root, projectId:'AI', coverHook:'Family', content:{ shots:[{ scene:'family portrait',duration:1 }] } });
  const variants = [];
  for (const plan of plans) {
    if (plan.passthrough) copyFileSync(f.output,plan.output);
    else {
      const args=[...plan.gradeArgs,'--out',plan.output,'--clarity','conservative','--quality-guard','report','--json'];
      const token=f.quality.beginCli(cli,args), report=JSON.parse(execute(process.execPath,[cli,...args]));
      f.quality.finishCli(token,{report});
    }
    variants.push({id:`variant:${plan.variant.id}`,path:plan.output,media:'video',fps:30,durationSeconds:1,
      requiredStages:['transitions',...(plan.passthrough?[]:['color'])],expectedColorCount:plan.passthrough?0:1,
      ...(plan.passthrough?{}:{expectedColorProfile:plan.variant.gradeProfile,expectedColorLut:plan.variant.gradeLut??null,
        expectedColorIntensity:plan.variant.gradeIntensity,expectedColorInputSha256:sourceSha})});
  }
  assert.equal(generationFileSha256(plans[0].output),sourceSha);
  const accepted=await f.quality.inspect({phase:'independent-ai-colors',scope:'delivery',
    artifacts:[{id:'master',path:f.output,media:'video',requiredStages:['transitions'],expectedColorCount:0,fps:30,durationSeconds:1},...variants],
    requirements:requirements.map(row=>row.name==='color'?{name:'color',requirement:'required'}:row),
    resolution:[160,90],sourceResolution:[160,90],variantIds:plans.map(plan=>plan.variant.id)});
  assert.equal(accepted.report.passed,true);
  assert.equal(accepted.manifest.processing.filter(proof=>proof.stage==='color').length,2);
  for (const [field, value, expected] of [
    ['expectedColorCount',2,'color-count'], ['expectedColorLut','look-cool-technical.cube','color-lut'],
    ['expectedColorIntensity',0.8,'color-intensity'], ['expectedColorInputSha256','a'.repeat(64),'color-input'],
  ]) await t.test(`wrong ${field} cannot pass actual receipt verification`,async()=>{
    const contract=structuredClone(accepted.manifest);contract.artifacts.find(row=>row.id==='variant:warm-story')[field]=value;
    const result=await inspectGenerationManifest({root:f.root,manifest:{generationQuality:contract},bins});
    assert.equal(result.passed,false);assert.ok(result.checks.some(row=>row.kind.endsWith(`chain:variant:warm-story:${expected}`)&&!row.ok));
  });
  await t.test('stacking a second real grade fails the independent-parent contract',async()=>{
    const output=path.join(f.root,'stacked.mp4'),args=['grade','--in',plans[1].output,'--out',output,'--profile','natural','--intensity','0.12','--no-auto','--clarity','conservative','--quality-guard','report','--json'];
    const token=f.quality.beginCli(cli,args),report=JSON.parse(execute(process.execPath,[cli,...args]));f.quality.finishCli(token,{report});
    await assert.rejects(f.quality.inspect({phase:'stack-rejected',scope:'delivery',
      artifacts:[{id:'master',path:f.output,media:'video',requiredStages:['transitions'],expectedColorCount:0},...variants.map(row=>row.id==='variant:content-auto'?{...row,path:output}:row)],
      requirements:requirements.map(row=>row.name==='color'?{name:'color',requirement:'required'}:row),
      resolution:[160,90],sourceResolution:[160,90],variantIds:plans.map(plan=>plan.variant.id)}),error=>error.report?.checks.some(row=>row.kind.endsWith('chain:variant:content-auto:color-count')&&!row.ok));
  });
  assert.equal(generationFileSha256(f.output),sourceSha);assert.deepEqual(f.sources.map(generationFileSha256),f.sourceHashes);
});
