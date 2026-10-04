import {afterEach,expect,it,vi} from "vitest";
import {WorkloomLLMEngine} from "./llm-adapter.js";
import {routeSmart,MockProvider,resetCircuit,type EventSink} from "@workloom/base/model-router";
afterEach(()=>{vi.unstubAllGlobals();resetCircuit();});
it("customer model remains the metered model and private data crosses the PII boundary",async()=>{
  const requests:Array<{url:string;body:any}>=[],traces:any[]=[];
  vi.stubGlobal("fetch",vi.fn(async(input,init)=>{
    requests.push({url:String(input),body:init?.body?JSON.parse(init.body):null});
    return String(input).endsWith("/models")?new Response("not implemented",{status:404}):new Response(JSON.stringify({choices:[{message:{content:'{"accepted":true}'}}],usage:{prompt_tokens:100,completion_tokens:20}}));
  }));
  const sink:EventSink={recordModelTrace:async t=>{traces.push(t);},recordDegradation:async()=>{},recordCircuitBreak:async()=>{}};
  const engine=new WorkloomLLMEngine({baseUrl:"https://configured.example.test/v1/",apiKey:"fixture-api-key",model:"customer-configured-model",thinking:{type:"disabled"}});
  engine.attachConfiguredRouter({sink,scene:"briefing"});
  const answer=await engine.reason("联系电话 13800000000，仅保留匿名联系信息",{forceJson:true});
  expect(answer.success).toBe(true);expect(traces[0].model_id).toBe("customer-configured-model");expect(traces[0].credits).toBeGreaterThan(0);
  const sent=requests.find(r=>r.body)!;expect(sent.body.model).toBe("customer-configured-model");expect(sent.body.thinking).toEqual({type:"disabled"});
  expect(JSON.stringify(sent.body.messages)).not.toContain("13800000000");expect(JSON.stringify(sent.body.messages)).toContain("[PII:PHONE:");
});
it("unregistered, empty and duplicate host chains fail before a provider can run",async()=>{
  const chat=vi.spyOn(MockProvider.prototype,"chat"),provider=new MockProvider("registered");
  const pool=new Map([[provider.modelId,provider]]),sink:EventSink={recordModelTrace:async()=>{},recordDegradation:async()=>{},recordCircuitBreak:async()=>{}};
  for(const modelChain of [[],["missing"],["registered","registered"]])
    await expect(routeSmart({action:"briefing",messages:[]},pool,sink,{modelChain})).rejects.toThrow(/registered providers/u);
  expect(chat).not.toHaveBeenCalled();chat.mockRestore();
});
