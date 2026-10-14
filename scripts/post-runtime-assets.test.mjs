import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {copyRuntimeSources} from './pack-workspace-modules.mjs';
const root=path.resolve(import.meta.dirname,'..'),product=JSON.parse(readFileSync(path.join(root,'product.manifest.json')));
const shared=['scripts/tools/generation-quality.mjs','scripts/tools/rhythm-edit.mts','scripts/tools/rhythm-post.mts','scripts/tools/edit-entity.mts','scripts/tools/vision-entity.swift'];
const video=['scripts/tools/edit-post.mts','scripts/tools/edit-cover.mts','scripts/tools/edit-package.mts','scripts/tools/lib/edit-rhythm.mts','scripts/tools/lib/frame-scan.mts','scripts/tools/lib/delivery-forms.mts'];
const assets=[...shared,...(product.repository.endsWith('/WorkLoom-video-edit')?video:[])],hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
function temp(t){const directory=mkdtempSync(path.join(tmpdir(),'post runtime 中文 空格-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return directory;}
const program=(file,args,options={})=>spawnSync(file,args,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,...options});

test('installed runtime preserves the actual quality, entity and rhythm dependency paths and module imports',async t=>{
 const destination=temp(t);
 if(existsSync(path.join(root,'scripts/product-runtime-assets.mjs'))){
  const {isRuntimeSource}=await import('./product-runtime-assets.mjs');
  for(const rel of assets){assert.equal(isRuntimeSource(rel,{includePlatformOps:false}),true,rel);assert.ok(existsSync(path.join(root,rel)),rel);}
  copyRuntimeSources(root,destination,assets);
 }else{
  for(const rel of ['scripts/pack-macos.sh','scripts/pack-windows.sh','scripts/pack-electron-payload.sh']){
   const text=readFileSync(path.join(root,rel),'utf8'),block=text.match(/# VIDEO_POST_RUNTIME_ASSETS:BEGIN\n([\s\S]*?)# VIDEO_POST_RUNTIME_ASSETS:END/u)?.[1];
   assert.ok(block,rel);const result=program('bash',['-eu','-c',`R="$1"\n${block}`, 'post-runtime-block',destination]);assert.equal(result.status,0,result.stderr||result.stdout);
   for(const ref of assets)assert.equal(hash(path.join(destination,ref)),hash(path.join(root,ref)),`${rel}: ${ref}`);
  }
 }
 const dependencies=['packages/video-studio/package.json','packages/video-studio/src','bundles/ai-video/connectors'];
 if(existsSync(path.join(root,'bundles/ai-video/library/root-list.mjs')))dependencies.push('bundles/ai-video/library/root-list.mjs');
 copyRuntimeSources(root,destination,dependencies);
 symlinkSync(path.join(root,'node_modules'),path.join(destination,'node_modules'),'dir');
 const modules=['scripts/tools/generation-quality.mjs','scripts/tools/rhythm-edit.mts','bundles/ai-video/connectors/color-bridge/entity-post.mjs','bundles/ai-video/connectors/post-bridge/rhythm-post.mjs'];
 const code=modules.map(ref=>`await import(${JSON.stringify(pathToFileURL(path.join(destination,ref)).href)});`).join('\n');
 const imported=program(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:destination});assert.equal(imported.status,0,imported.stderr||imported.stdout);
 for(const ref of assets)assert.equal(hash(path.join(destination,ref)),hash(path.join(root,ref)),ref);
 assert.equal(existsSync(path.join(destination,'work')),false);assert.equal(existsSync(path.join(destination,'outputs')),false);
});

test('manual post runtime blocks fail if a required processor is missing after copy',t=>{
 if(existsSync(path.join(root,'scripts/product-runtime-assets.mjs'))) {
  const bundle=JSON.parse(readFileSync(path.join(root,'bundles/ai-video/bundle.json')));
  for(const ref of ['connectors/post-bridge/quality-gate.mjs','connectors/post-bridge/rhythm-post.mjs','connectors/color-bridge/entity-post.mjs'])assert.ok(bundle.workloom.provides.connectors.includes(ref));
  return;
 }
 const destination=temp(t),text=readFileSync(path.join(root,'scripts/pack-electron-payload.sh'),'utf8'),block=text.match(/# VIDEO_POST_RUNTIME_ASSETS:BEGIN\n([\s\S]*?)# VIDEO_POST_RUNTIME_ASSETS:END/u)[1];
 // Execute the real guard after a real copy, deleting one copied file between the two operations.
 const changed=block.replace('for post_runtime_asset in', 'rm "$R/scripts/tools/generation-quality.mjs"\nfor post_runtime_asset in');
 const result=program('bash',['-eu','-c',`R="$1"\n${changed}`,'post-runtime-missing',destination]);assert.notEqual(result.status,0);assert.match(result.stdout,/generation-quality\.mjs/u);
 assert.equal(existsSync(path.join(destination,'scripts/tools/generation-quality.mjs')),false);
});
