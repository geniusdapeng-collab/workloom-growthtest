/** Import closure + real contracts from a physically copied customer payload. No network/DB calls. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
if(process.env.WORKLOOM_RUNTIME_PREFLIGHT!=="1") throw new Error("Preflight requires an isolated host");
globalThis.fetch=async()=>{throw new Error("PREFLIGHT_NETWORK_FORBIDDEN");};
const {resolveDeliveryTargets,buildDirectorDefaults}=await import("@hyperreality/video-studio");
if(resolveDeliveryTargets("雨后民宿电影").expectedOutputs!==4) throw new Error("Director policy contract failed");
if(buildDirectorDefaults({intent:"创业人物短片"}).confirmationSteps!==0) throw new Error("Director user-cost contract failed");
const require=createRequire(path.join(root,"package.json"));
require(path.join(root,"vendor/supermickey/hyperreality-system/index.js"));
require(path.join(root,"vendor/supermickey/systems/llm-reasoning-engine.js"));
const {appRouter}=await import("../apps/server/src/trpc/router.js");
if(!appRouter) throw new Error("Server router unavailable");
const product=JSON.parse(await readFile(path.join(root,"product.manifest.json"),"utf8"));
const {composeWorkforce}=await import("@workloom/base/bundles");
const workforce=composeWorkforce(product.defaultBundle,path.join(root,"bundles"));
if(!workforce.presets.size) throw new Error("Verified product workforce is empty");
const {loadCatalog}=await import("./agent-capabilities.mjs");
const catalog=await loadCatalog();if(!catalog) throw new Error("Agent catalog unavailable");
console.log("RUNTIME_PREFLIGHT "+JSON.stringify({status:"passed",platform:process.platform,arch:process.arch,
  checks:["physical-internal-package","director-policy","vendor-import","server-router-import","verified-bundle-composition","agent-catalog"],networkCalls:0}));
