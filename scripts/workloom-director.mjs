#!/usr/bin/env node
/** Fixed, authenticated service API for one-intent director tasks. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CapabilityError, sanitizeErrorMessage } from './agent-capabilities.mjs';
const COMMANDS=Object.freeze({start:['start','POST'],plan:['start','POST'],targets:['resolveTargets','GET'],job:['job','GET'],
 jobs:['jobs','GET'],versions:['getVersions','GET'],render:['renderVariants','POST'],feedback:['feedback','POST'],
 cancel:['cancel','POST'],budget:['approveBudget','POST'],'authorize-identity':['authorizeIdentity','POST'],
 preferences:['preferences','GET'],choose:['choose','POST'],calibration:['calibration','GET']});
export async function requestDirector(command,input={}, {env=process.env,fetcher=fetch,root=path.resolve(import.meta.dirname,'..')}={}) {
 const descriptor=COMMANDS[command];
 if(!descriptor) throw new CapabilityError('USAGE','命令须为 '+Object.keys(COMMANDS).join('|'),2);
 if(!input||typeof input!=='object'||Array.isArray(input)) throw new CapabilityError('INVALID_INPUT','输入须为 JSON 对象',2);
 if(Buffer.byteLength(JSON.stringify(input))>1024*1024) throw new CapabilityError('INVALID_INPUT','输入超过 1 MiB',2);
 const product=JSON.parse(await readFile(path.join(root,'product.manifest.json'),'utf8'));
 let base;
 try{base=new URL(env.WORKLOOM_BASE_URL??`http://127.0.0.1:${8787+(product.desktop?.portOffset??0)}`);}
 catch{throw new CapabilityError('INVALID_BASE_URL','服务地址无效',2);}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(base.hostname);
 if(!(base.protocol==='https:'||base.protocol==='http:'&&loopback)||base.username||base.password||base.search||base.hash||!['','/'].includes(base.pathname))
  throw new CapabilityError('INVALID_BASE_URL','服务须为 HTTPS 或本机回环 HTTP，地址不能含凭据或路径',2);
 let token=env.WORKLOOM_ACCESS_TOKEN;
 if(!token) throw new CapabilityError('UNAUTHORIZED','请通过 WORKLOOM_ACCESS_TOKEN 提供当前工作区成员令牌',3);
 const wire=command==='plan'?{...input,mode:'plan'}:input;
 const [route,method]=descriptor,url=new URL(`/trpc/video.creative.${route}`,base);
 if(method==='GET'&&Object.keys(wire).length)url.searchParams.set('input',JSON.stringify(wire));
 let response,body;
 try {
  response=await fetcher(url,{method,headers:{authorization:'Bearer '+token,...(method==='POST'?{'content-type':'application/json'}:{})},
   ...(method==='POST'?{body:JSON.stringify(wire)}:{}),signal:AbortSignal.timeout(30000)});
  body=await response.json();
 }catch(error){throw new CapabilityError('SERVICE_UNAVAILABLE',sanitizeErrorMessage(error,env),7);}
 if(!response.ok||body?.error){
  const fault=body?.error?.json??body?.error;
  throw new CapabilityError(String(fault?.data?.code??'REMOTE_ERROR'),sanitizeErrorMessage(fault?.message??`HTTP ${response.status}`,env),response.status===401?3:response.status===403?4:7);
 }
 if(!body?.result||!Object.hasOwn(body.result,'data'))throw new CapabilityError('REMOTE_INVALID','服务响应缺少 result.data',7);
 return {schemaVersion:'workloom.director-cli/v2',command,result:body.result.data};
}
async function main(){
 const [command,...args]=process.argv.slice(2);
 if(command==='--help'||!command){console.log('workloom-director.mjs '+Object.keys(COMMANDS).join('|')+' [--input-file JSON文件或-]\n凭据和服务地址只从环境读取。plan 强制只运行真实文本模型。');return;}
 if(args.length&&!(args.length===2&&args[0]==='--input-file'))throw new CapabilityError('USAGE','只接受 --input-file <JSON文件或->',2);
 let input={};
 if(args.length){let source;if(args[1]==='-'){const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new CapabilityError('INVALID_INPUT','输入超过 1 MiB',2);chunks.push(chunk);}source=Buffer.concat(chunks).toString('utf8');}else source=await readFile(args[1],'utf8');
  try{input=JSON.parse(source);}catch{throw new CapabilityError('INVALID_INPUT','输入不是合法 JSON',2);}}
 console.log(JSON.stringify(await requestDirector(command,input)));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try{await main();}catch(error){console.error(JSON.stringify({error:{code:error.code??'INTERNAL_ERROR',message:sanitizeErrorMessage(error)}}));process.exitCode=error.exitCode??1;}
}
