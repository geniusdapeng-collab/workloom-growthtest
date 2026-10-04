"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const http=require("node:http");
const {once}=require("node:events");
const {ensureDesktopSigningSecrets,spawnLogged,desktopServiceHealthy,assertTcpPortFree}=require("./bootstrap.cjs");

test("signing keys persist independently and a valid existing key is preserved",()=>{
  const first=ensureDesktopSigningSecrets("LLM_PROVIDER=mock\n");
  const keys=["WORKLOOM_RENDER_SIGNING_SECRET","WORKLOOM_AUDIO_STEM_SIGNING_SECRET","HUMAN_CONFIRMATION_SECRET"]
    .map(key=>first.match(new RegExp(`^${key}=(.+)$`,"m"))[1]);
  assert.equal(new Set(keys).size,3);assert.ok(keys.every(value=>/^[a-f0-9]{64}$/.test(value)));
  assert.equal(ensureDesktopSigningSecrets(first),first);
});
test("a failed child has an actionable startup error and writes a bounded diagnostic",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wl-startup-"));
  try{
    const log=path.join(dir,"child.log");
    const child=spawnLogged(path.join(dir,"missing-node"),[],{},log);
    await once(child,"error");
    assert.equal(child.startupError.code,"ENOENT");
    assert.match(fs.readFileSync(log,"utf8"),/missing-node: ENOENT/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("HTTP 200 from another local instance does not pass desktop readiness",async()=>{
  let body={ok:true,desktopInstanceId:"another-instance",productId:"growth"};
  const server=http.createServer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify(body));});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const port=server.address().port,url=`http://127.0.0.1:${port}/health`;
  try{
    assert.equal(await desktopServiceHealthy(url,"this-instance","growth"),false);
    body={...body,desktopInstanceId:"this-instance"};
    assert.equal(await desktopServiceHealthy(url,"this-instance","growth"),true);
    await assert.rejects(assertTcpPortFree(port,"服务"),/EADDRINUSE/);
  }finally{await new Promise(resolve=>server.close(resolve));}
  await assertTcpPortFree(port,"服务");
});
