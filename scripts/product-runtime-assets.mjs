#!/usr/bin/env node
/** One source allowlist for Electron, macOS ZIP and Windows ZIP payloads. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRuntimePayloadBoundary, loadPayloadPolicy } from "./payload-policy.mjs";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const TOP_FILES=new Set(["package.json","pnpm-workspace.yaml","tsconfig.base.json",".env.example","product.manifest.json"]);
const SCRIPT_FILES=new Set(["migrate.ts","desktop-bootstrap-db.mjs","product-runtime.mjs","vite-product.mjs",
  "skill-bindings.mts","workloom-agent.mjs","workloom-agent-mcp.mjs","agent-capabilities.mjs","agent-capabilities.core.json",
  "runtime-payload-probe.mts","media-runtime.mjs","media-runtime-lock.json","workloom-director.mjs"]);
const SOURCE_PREFIXES=["apps/server/","apps/web/src/","apps/web/public/","packages/","bundles/","skills/",
  "vendor/supermickey/","vendor/srt-whiteboard/","vendor/dsh/","scripts/tools/","scripts/whiteboard/","assets/whiteboard/"];
const WEB_FILES=new Set(["apps/web/index.html","apps/web/package.json","apps/web/vite.config.ts","apps/web/tsconfig.json"]);
const BLOCKED_SEGMENTS=new Set(["node_modules",".git",".dsh-home",".venv","__pycache__",".cache","out","outputs","logs"]);

export function isRuntimeSource(relativePath,policy) {
  const ref=String(relativePath).replaceAll("\\","/");
  const parts=ref.split("/");
  if(!ref || path.isAbsolute(ref) || parts.some(p=>!p||p===".."||p==="."||BLOCKED_SEGMENTS.has(p))) return false;
  if(parts.some(p=>/^\.env(?:\.|$)/u.test(p)&&p!==".env.example")) return false;
  if(/(?:\.test\.|\.spec\.|\/__tests__\/|\/fixtures\/|\/test-fixtures\/|\/tests\/|\/coverage\/)/u.test(ref)) return false;
  if(/\.(?:log|pyc|pyo|bak|sqlite|db|pem|key)$/iu.test(ref)) return false;
  if(ref.startsWith("packages/runtime/dsh-gate/out/") || ref.includes("/dist/") && !ref.startsWith("vendor/dsh/dist/")) return false;
  if(TOP_FILES.has(ref)||WEB_FILES.has(ref)||SOURCE_PREFIXES.some(prefix=>ref.startsWith(prefix))) return true;
  if(ref.startsWith("platform-ops/")) return policy.includePlatformOps;
  if(parts[0]==="scripts"&&parts.length===2) return SCRIPT_FILES.has(parts[1])||/^seed[^/]*\.ts$/u.test(parts[1]);
  return false;
}

function inventory(root) {
  try {return [...new Set(execFileSync("git",["ls-files","--cached","--others","--exclude-standard","-z"],
    {cwd:root,encoding:"utf8",maxBuffer:16*1024*1024}).split("\0").filter(Boolean))].sort();}
  catch(error) {throw new Error("装配必须从可追溯 Git 工作区读取源码清单",{cause:error});}
}
function safeTarget(root,ref) {
  const file=path.resolve(root,...ref.split("/"));
  if(!file.startsWith(path.resolve(root)+path.sep)) throw new Error(`载荷路径越界：${ref}`);
  return file;
}
function digest(file) {return createHash("sha256").update(readFileSync(file)).digest("hex");}

export function copyRuntimeSources(root,destination,{version="v0.0.0"}={}) {
  root=path.resolve(root);destination=path.resolve(destination);
  if(destination===root || root.startsWith(destination+path.sep)) throw new Error("载荷目标不得覆盖源码工作区");
  const compiler=path.join(root,"node_modules/typescript/bin/tsc");
  if(!existsSync(compiler)) throw new Error("装配缺少 TypeScript 构建器，请先安装工作区依赖");
  execFileSync(process.execPath,[compiler,"-p","packages/industry-contract/tsconfig.json"],{cwd:root,timeout:120_000,stdio:"pipe"});
  const policy=loadPayloadPolicy(root);
  const files=inventory(root).filter(ref=>isRuntimeSource(ref,policy));
  mkdirSync(destination,{recursive:true});
  const receipts=[];
  for(const ref of files) {
    const source=safeTarget(root,ref),target=safeTarget(destination,ref);
    if(!existsSync(source)) continue; // deleted tracked files are absent in this revision
    const info=lstatSync(source);
    if(!info.isFile()||info.isSymbolicLink()) throw new Error(`源码载荷不接受符号链接或特殊文件：${ref}`);
    mkdirSync(path.dirname(target),{recursive:true});cpSync(source,target);
    receipts.push({path:ref,sha256:digest(target),bytes:info.size});
  }
  // The industry contract exports generated JS and declarations, even though its
  // source package is copied as TS. An import probe must see the same build as CI.
  const contractDist=path.join(root,"packages/industry-contract/dist");
  if(!existsSync(path.join(contractDist,"index.js"))||!existsSync(path.join(contractDist,"index.d.ts")))
    throw new Error("载荷缺少 industry-contract 构建产物；请先构建 packages/industry-contract");
  for(const entry of readdirSync(contractDist,{withFileTypes:true})) {
    if(!entry.isFile()||!/(?:\.js|\.d\.ts)$/u.test(entry.name)) continue;
    const ref=`packages/industry-contract/dist/${entry.name}`,source=path.join(contractDist,entry.name),target=safeTarget(destination,ref);
    mkdirSync(path.dirname(target),{recursive:true});cpSync(source,target);
    receipts.push({path:ref,sha256:digest(target),bytes:lstatSync(source).size,origin:"compiled-internal-contract"});
  }
  if(!existsSync(path.join(destination,".env.example"))) throw new Error("载荷缺少无凭据的默认配置模板");
  cpSync(path.join(destination,".env.example"),path.join(destination,".env.defaults"));
  writeFileSync(path.join(destination,"VERSION"),`${version}\n`);
  // The upstream systems/ folder contains CommonJS .js files but no package
  // boundary. Make its existing syntax explicit in the derived payload only.
  const vendor=path.join(destination,"vendor/supermickey");
  if(existsSync(vendor)&&!existsSync(path.join(vendor,"package.json"))) writeFileSync(path.join(vendor,"package.json"),
    JSON.stringify({name:"workloom-vendored-supermickey",private:true,type:"commonjs"})+"\n");
  writeFileSync(path.join(destination,"RUNTIME_ASSETS.json"),JSON.stringify({schemaVersion:"workloom.runtime-assets/v1",
    productId:policy.productId,manifestSha256:policy.manifestSha256,version,files:receipts},null,2)+"\n");
  assertRuntimePayloadBoundary(destination,policy);
  return {productId:policy.productId,files:receipts.length};
}

/** Only copied internal packages lose their node_modules. External npm nesting is preserved. */
export function installInternalPackages(runtimeRoot) {
  const runtime=path.resolve(runtimeRoot),policy=loadPayloadPolicy(runtime);
  const roots=readdirSync(path.join(runtime,"packages"),{withFileTypes:true}).filter(e=>e.isDirectory())
    .map(e=>path.join(runtime,"packages",e.name));
  if(policy.includePlatformOps) roots.push(path.join(runtime,"platform-ops"));
  const names=[];
  for(const source of roots) {
    const manifest=path.join(source,"package.json");if(!existsSync(manifest)) continue;
    const {name}=JSON.parse(readFileSync(manifest,"utf8"));
    if(typeof name!=="string"||!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name)) throw new Error("内部包名非法");
    const target=safeTarget(runtime,`node_modules/${name}`);
    rmSync(target,{force:true,recursive:true});mkdirSync(path.dirname(target),{recursive:true});
    cpSync(source,target,{recursive:true,dereference:false,filter:file=>!path.relative(source,file).split(path.sep).includes("node_modules")});
    names.push(name);
  }
  assertRuntimePayloadBoundary(runtime,policy);return names;
}

/** Execute with the target Node and isolated environment; cross-target inspection is labeled. */
export function preflightRuntime(runtimeRoot,{node=process.execPath,platform=process.platform,arch=process.arch}={}) {
  const runtime=path.resolve(runtimeRoot);
  assertRuntimePayloadBoundary(runtime,loadPayloadPolicy(runtime));
  const required=["scripts/skill-bindings.mts","scripts/workloom-agent.mjs","scripts/workloom-agent-mcp.mjs",
    "scripts/runtime-payload-probe.mts","vendor/supermickey/hyperreality-system/index.js",
    "bundles/ai-video/library/director-system/core.mjs","apps/web/dist/index.html","node_modules/tsx/dist/cli.mjs"];
  for(const ref of required) if(!existsSync(safeTarget(runtime,ref))) throw new Error(`载荷依赖缺失：${ref}`);
  if(platform!==process.platform||arch!==process.arch) return {status:"target-execution-required",platform,arch,structural:true};
  const output=execFileSync(node,[path.join(runtime,"node_modules/tsx/dist/cli.mjs"),path.join(runtime,"scripts/runtime-payload-probe.mts")],
    {cwd:runtime,encoding:"utf8",timeout:120_000,maxBuffer:8*1024*1024,
      env:{PATH:path.dirname(node)+(platform==="win32"?";":":")+(platform==="win32"?(process.env.SystemRoot??"C:\\Windows")+"\\System32":"/usr/bin:/bin"),
        ...(platform==="win32"?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{}),
        NODE_ENV:"production",LLM_PROVIDER:"mock",JWT_SECRET:cryptoRandom(),PII_SALT:cryptoRandom(),
        HUMAN_CONFIRMATION_SECRET:cryptoRandom(),WORKLOOM_RUNTIME_PREFLIGHT:"1",
        ...(existsSync(path.join(ROOT,"build/bundle-trust.json"))?{BUNDLE_VERIFICATION_KEYS:readFileSync(path.join(ROOT,"build/bundle-trust.json"),"utf8")}:{}),
      }});
  const line=output.trim().split(/\r?\n/u).findLast(value=>value.startsWith("RUNTIME_PREFLIGHT "));
  if(!line) throw new Error("载荷执行没有完成回执");
  const receipt=JSON.parse(line.slice("RUNTIME_PREFLIGHT ".length));
  if(receipt.status!=="passed") throw new Error("载荷执行未通过");return receipt;
}
function cryptoRandom(){return randomBytes(32).toString("hex");}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [command,destination,...args]=process.argv.slice(2);if(!destination) throw new Error("用法：product-runtime-assets.mjs copy|install|preflight <runtime> [--version v] [--platform os --arch cpu]");
    const option=name=>args[args.indexOf(name)+1];
    const receipt=command==="copy"?copyRuntimeSources(ROOT,destination,{version:args.includes("--version")?option("--version"):undefined})
      :command==="install"?installInternalPackages(destination)
      :command==="preflight"?preflightRuntime(destination,{platform:args.includes("--platform")?option("--platform"):undefined,
        arch:args.includes("--arch")?option("--arch"):undefined}):null;
    if(receipt===null) throw new Error("未知载荷动作");console.log(JSON.stringify(receipt));
  } catch(error) {console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
