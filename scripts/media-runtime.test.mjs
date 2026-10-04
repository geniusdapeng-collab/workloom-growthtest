import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { MEDIA_RUNTIME_LOCK, ensureMediaRuntime, verifyMediaBytes } from './media-runtime.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
test('corrupt or oversized downloads fail integrity without installation', () => {
 const data=Buffer.from('locked');
 assert.equal(verifyMediaBytes(data,digest(data),data.length),data);
 assert.throws(()=>verifyMediaBytes(Buffer.from('changed'),digest(data),data.length),{code:'MEDIA_DOWNLOAD_INTEGRITY'});
 assert.throws(()=>verifyMediaBytes(data,digest(data),data.length+1),{code:'MEDIA_DOWNLOAD_INTEGRITY'});
});
test('atomic installation, foreign-target cache, tamper recovery and concurrent exclusion', async () => {
 const cacheDir=await mkdtemp(path.join(os.tmpdir(),'workloom-media-'));
 const key='fixture-x64', downloads=new Map();
 const manifest={};
 for (const name of ['ffmpeg','ffprobe','license','readme']) {
  const bytes=Buffer.from('public test '+name), url='https://fixture.invalid/'+name;
  if(name.startsWith('ff')) {const compressed=gzipSync(bytes);downloads.set(url,compressed);manifest[name]={url,sha256:digest(bytes),bytes:bytes.length,compressedSha256:digest(compressed),compressedBytes:compressed.length};}
  else {downloads.set(url,bytes);manifest[name]={url,sha256:digest(bytes),bytes:bytes.length};}
 }
 MEDIA_RUNTIME_LOCK.platforms[key]=manifest;
 let fetches=0;
 const downloader=async url=>{fetches++;return downloads.get(url);};
 const runner=async()=>{throw new Error('foreign binary must not execute');};
 try {
  const first=await ensureMediaRuntime({cacheDir,platform:'fixture',arch:'x64',downloader,runner});
  assert.equal(first.installed,true);assert.equal(fetches,4);
  const second=await ensureMediaRuntime({cacheDir,platform:'fixture',arch:'x64',downloader,runner});
  assert.equal(second.installed,false);assert.equal(fetches,4);
  await writeFile(first.ffmpeg,'tamper');
  const repaired=await ensureMediaRuntime({cacheDir,platform:'fixture',arch:'x64',downloader,runner});
  assert.equal(repaired.installed,true);assert.equal(fetches,8);
  assert.equal(digest(await readFile(repaired.ffmpeg)),manifest.ffmpeg.sha256);
  await rm(path.dirname(first.ffmpeg),{recursive:true});
  let release;let started;
  const pending=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{started=resolve;});
  const install=ensureMediaRuntime({cacheDir,platform:'fixture',arch:'x64',runner,downloader:async url=>{started();await pending;return downloads.get(url);}});
  await ready;
  await assert.rejects(ensureMediaRuntime({cacheDir,platform:'fixture',arch:'x64',downloader,runner}),{code:'MEDIA_INSTALL_BUSY'});
  release();await install;
 } finally {delete MEDIA_RUNTIME_LOCK.platforms[key];await rm(cacheDir,{recursive:true,force:true});}
});
