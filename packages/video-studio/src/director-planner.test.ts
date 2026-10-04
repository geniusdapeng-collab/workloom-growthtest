import { describe, expect, it } from "vitest";
import { planDirectorFilm, type DirectorPlannerEngine, type DirectorCallReceipt } from "./director-planner.js";
import { buildPostVariantPlans, directorHash, resolveDeliveryTargets } from "./director-v2.js";

const intent="江边民宿短片，雨后安静的生活";
const targets=resolveDeliveryTargets(intent);
const book={shots:["establishing","hero","action","detail","resolution"].map((role,i)=>({
  shotId:`SC-${i+1}`,role,durationSec:6,dialogue:i===2?"雨停了，生活慢下来。":"",
  action:"人物停下观察水面的光",scene:"雨后的江边",lighting:"窗边方向柔光，保留暗部层次",
  composition:"中景保留双眼和空间",camera:"平视缓慢推进",styling:"合身自然衣着",
  audio:{dialogue:i===2?"完整旁白":"",ambience:"轻柔的江风",foley:"克制动作细节",music:"post-only"},
  events:[{atSec:2,kind:"转头"}],
}))};
function response(stage:string):Record<string,unknown> {
  if(stage==="导演与美术") return {title:"雨后江边",logline:"雨停后感受安静生活",emotionalArc:"从忙到静",
    visualMotif:"水面光影",presentation:"自然有张力",world:"真实民宿",hardFacts:[],assumptions:[{value:"雨后拍摄",origin:"inferred"}],chronologyLocked:false};
  if(stage==="摄影、表演与声音") return structuredClone(book);
  if(stage==="剪辑导演") return {versions:targets.targets.map((target,i)=>({variantId:target.variantId,
    openingShotId:i===0?"SC-3":"SC-4",shotOrder:["SC-4","SC-2","SC-1","SC-3","SC-5"],
    rhythm:"按表演切点",soundMotif:"江风与静默",look:"保护自然肤色",subtitle:"整句克制",cover:"光影细节",copy:"雨后江边",differenceReason:"开场与节奏变化"}))};
  return {passed:true,issues:[],identity:"bound",factsPolicy:"无额外承诺",renderSubmitted:false,ordinaryConfirmations:0};
}
function engine(transform?:(data:Record<string,unknown>,stage:string,count:number)=>Record<string,unknown>) {
  const prompts:string[]=[];
  const value:DirectorPlannerEngine={reasonStructured:async(prompt,_schema,options)=>{
    prompts.push(prompt);expect(options?.timeoutMs).toBeGreaterThan(0);
    const stage=prompt.match(/当前岗位：([^。]+)。/u)?.[1]??"";
    const data=transform?transform(response(stage),stage,prompts.length):response(stage);
    return {success:true,data,content:JSON.stringify(data),usage:{promptTokens:100,completionTokens:50}};
  }};
  return {value,prompts};
}
describe("导演语言模型真实链的执行边界与契约",()=>{
  it("四岗位规划具有独立回执，模型自报身份不能成为授权",async()=>{
    const e=engine();const plan=await planDirectorFilm({intent,engine:e.value});
    expect(e.prompts).toHaveLength(4);expect(plan.callReceipts).toHaveLength(4);
    expect(plan.callReceipts.every(r=>r.success&&r.responseSha256&&r.usage?.promptTokens===100)).toBe(true);
    expect(plan.review.identity).toBe("unverified");expect(plan.review.mediaQuality).toBe("unverified");
    expect(plan.mediaReady).toBe(false);expect(plan.renderApiCalls).toBe(0);expect(plan.imageApiCalls).toBe(0);
    expect(plan.confirmationSteps).toBe(0);
    expect(e.prompts.every(p=>p.includes("普通创作自行决定")&&p.includes("不执行图像、视频、配音或发布"))).toBe(true);
  });
  it("本人素材缺失在第一次模型调用前阻断",async()=>{
    const e=engine();await expect(planDirectorFilm({intent:"我本人生日短片",engine:e.value})).rejects.toThrow("IDENTITY_ASSET_REQUIRED");
    expect(e.prompts).toHaveLength(0);
  });
  it("可解析但契约不完整的响应先记失败，再受限修复一次",async()=>{
    const receipts:DirectorCallReceipt[]=[];
    const e=engine((data,_stage,count)=>count===1?{title:"只返回标题"}:data);
    const plan=await planDirectorFilm({intent,engine:e.value,onProgress:(_stage,rows)=>{receipts.splice(0,receipts.length,...rows);}});
    expect(e.prompts).toHaveLength(5);expect(plan.callReceipts[0]?.success).toBe(false);
    expect(plan.callReceipts[1]?.success).toBe(true);expect(receipts).toHaveLength(5);
    expect(e.prompts[1]).toContain("上次契约错误");
  });
  it("未知镜头引用两次仍错即终止，不能跑下游复核",async()=>{
    const e=engine((data,stage)=>stage==="剪辑导演"?{versions:targets.targets.map(t=>({...(response(stage).versions as Array<Record<string,unknown>>)[0],variantId:t.variantId,openingShotId:"SC-999"}))}:data);
    await expect(planDirectorFilm({intent,engine:e.value})).rejects.toThrow("DIRECTOR_MODEL_FAILED");
    expect(e.prompts).toHaveLength(4);expect(e.prompts.every(p=>!p.includes("当前岗位：独立制作复核"))).toBe(true);
  });
  it("用户取消和到期均在调用前停止",async()=>{
    const e=engine(),controller=new AbortController();controller.abort();
    await expect(planDirectorFilm({intent,engine:e.value,signal:controller.signal})).rejects.toThrow("DIRECTOR_CANCELLED");
    await expect(planDirectorFilm({intent,engine:e.value,deadlineMs:Date.now()-1})).rejects.toThrow("DIRECTOR_TIMEOUT");
    expect(e.prompts).toHaveLength(0);
  });
  it("导演排列进入实际剪辑合同，硬时序与台词顺序优先",()=>{
    const source={fps:30,shots:book.shots.map((s,i)=>({...s,sha256:directorHash(i)}))};
    const narratives=targets.targets.map(t=>({variantId:t.variantId,openingShotId:"SC-4",shotOrder:["SC-4","SC-5","SC-3","SC-2","SC-1"]}));
    const plans=buildPostVariantPlans({sourceManifest:source,targetPlan:targets,narrativePlans:narratives});
    expect(plans.every(p=>p.pictureEdl[0]?.sourceId==="SC-4")).toBe(true);
    const locked=buildPostVariantPlans({sourceManifest:{...source,chronologyLocked:true},targetPlan:targets,narrativePlans:narratives});
    expect(locked.every(p=>p.pictureEdl.map(e=>e.sourceId).join(",")==="SC-1,SC-2,SC-3,SC-4,SC-5")).toBe(true);
  });
});
