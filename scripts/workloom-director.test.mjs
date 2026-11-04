import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestDirector} from './workloom-director.mjs';
const env={WORKLOOM_BASE_URL:'http://127.0.0.1:59082',WORKLOOM_ACCESS_TOKEN:'fixture-workspace-token'};
test('plan enforces text-only mode and credentials remain outside the body',async()=>{
 let request;
 const result=await requestDirector('plan',{intent:'雨后民宿',mode:'produce',idempotencyKey:'fixture-one'},
  {env,fetcher:async(url,init)=>{request={url:String(url),...init};return new Response(JSON.stringify({result:{data:{status:'queued'}}}));}});
 assert.equal(result.result.status,'queued');assert.equal(JSON.parse(request.body).mode,'plan');
 assert.equal(request.headers.authorization,'Bearer '+env.WORKLOOM_ACCESS_TOKEN);assert.ok(!request.body.includes(env.WORKLOOM_ACCESS_TOKEN));
});
test('director demand commands preserve 12000 Unicode characters and reject overflow before networking',async()=>{
 for(const command of ['start','plan','targets'])for(const character of ['汉','𠮷']){
  const raw=character.repeat(12000);let received,calls=0;
  const fetcher=async(url,init)=>{calls++;received=init.method==='GET'?JSON.parse(url.searchParams.get('input')):JSON.parse(init.body);
   return Response.json({result:{data:{status:'queued'}}});};
  await requestDirector(command,{intent:raw,idempotencyKey:'unicode-test'},{env,fetcher});assert.equal(received.intent,raw);
  await assert.rejects(requestDirector(command,{intent:raw+character},{env,fetcher}),{code:'INVALID_INPUT'});
  assert.equal(calls,1);
 }
});
test('missing identity, unsafe remote URLs and oversized inputs reject before networking',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw new Error('unexpected network');};
 await assert.rejects(requestDirector('start',{}, {env:{},fetcher}),{code:'UNAUTHORIZED'});
 for(const base of ['http://remote.example.test','https://name:password@example.test','https://example.test/private','https://example.test?secret=x'])
  await assert.rejects(requestDirector('start',{}, {env:{...env,WORKLOOM_BASE_URL:base},fetcher}),{code:'INVALID_BASE_URL'});
 await assert.rejects(requestDirector('start',{intent:'x'.repeat(1048576)},{env,fetcher}),{code:'INVALID_INPUT'});assert.equal(calls,0);
});
test('permission and malformed response failures remain visible and redact tokens',async()=>{
 await assert.rejects(requestDirector('start',{}, {env,fetcher:async()=>new Response(JSON.stringify({error:{message:'Denied '+env.WORKLOOM_ACCESS_TOKEN,data:{code:'FORBIDDEN'}}}),{status:403})}),error=>error.code==='FORBIDDEN'&&!error.message.includes(env.WORKLOOM_ACCESS_TOKEN));
 await assert.rejects(requestDirector('job',{jobId:'fixture'},{env,fetcher:async()=>new Response('{}')}),{code:'REMOTE_INVALID'});
});
