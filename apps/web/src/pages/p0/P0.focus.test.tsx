// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import P0 from "./P0";

const channels = vi.hoisted(() => ({
  navigate: vi.fn(),
  theater: {mode:"active",ceoName:"公司负责人",pendingByTier:{},latestBriefing:null,ticker:[],
    satellites:[] as Array<{id:string;presetKey:string;name:string;grade:string}>,
    floor:{agents:[] as Array<{id:string;presetKey:string;name:string;state:string;currentThread?:{id:string;title:string}}>}},
}));
vi.mock("react-router", () => ({useNavigate:()=>channels.navigate}));
vi.mock("../../lib/trpc", () => ({ensureDemoLogin:async()=>{},isLocalFull:()=>true,
  trpc:{onboarding:{status:{query:async()=>({workspace:{name:"本地焦点测试"}})},welcomeStatus:{query:async()=>({status:"completed",shouldShow:false})}},
    captain:{theater:{query:async()=>channels.theater}}}}));
vi.mock("../../shell/NavigationAccess", () => ({useNavigationAccess:()=>({bundle:null,entries:[],canAction:()=>false,subject:null})}));
vi.mock("../../components/Floor3D", () => ({Floor3D:({floor,onOpenProfile,onOpenTask}:{floor:typeof channels.theater.floor;onOpenProfile:(agent:typeof channels.theater.floor.agents[number])=>void;onOpenTask:(id:string)=>void})=>(
  <section data-product-scene="controlled-workplace">{floor.agents.filter(agent=>agent.state!=="disabled").map(agent=>(
    <button key={agent.id} data-worker-id={agent.id} onClick={()=>agent.currentThread?onOpenTask(agent.currentThread.id):onOpenProfile(agent)} onKeyDown={event=>{if(event.key==="Escape")event.currentTarget.blur();}}>{agent.name}</button>
  ))}</section>
)}));
vi.mock("./Floor", () => ({FloorView:()=>null}));
vi.mock("../../components/Stage3D", () => ({Stage3D:({agents,onPick}:{agents:typeof channels.theater.satellites;onPick:(agent:typeof channels.theater.satellites[number])=>void})=>(
  <section data-product-scene="controlled-report-stage">{agents.map(agent=><button key={agent.id} data-worker-id={agent.id} onClick={()=>onPick(agent)}>{agent.name}</button>)}</section>
)}));
vi.mock("../../components/CommandCard",()=>({CommandCard:()=>null}));
vi.mock("../../components/SimBanner",()=>({SimBanner:()=>null}));
vi.mock("../../components/SkillDistBanner",()=>({SkillDistBanner:()=>null}));
vi.mock("../../components/WelcomeCeremony",()=>({WelcomeCeremony:()=>null}));
vi.mock("../../components/ValueCounters",()=>({ValueCounters:()=>null}));
vi.mock("../../components/mate-guide/QuestlineHud",()=>({QuestlineHud:()=>null}));
vi.mock("../../components/mate-guide/QuestlineOverlay",()=>({QuestlineOverlay:()=>null}));
vi.mock("../../onboarding/useQuestline",()=>({useQuestline:()=>({state:{achievements:[]}})}));
vi.mock("../../onboarding/questline",()=>({EMPTY_FACTS:{},factsFromRecentActions:()=>({})}));
vi.mock("../../onboarding/questline.config",()=>({questlineForBundle:()=>null}));
vi.mock("../../onboarding/QuestlineContent",()=>({QuestlineContentProvider:({children}:{children:React.ReactNode})=><>{children}</>}));
vi.mock("../../lib/theaterDiff",()=>({useTheaterDiff:()=>null}));
vi.mock("../../lib/naming",()=>({displayNameOf:()=>"测试岗位",hydrateAliases:()=>{},reportTitleOf:()=>"测试岗位",selectReporters:()=>[]}));
vi.mock("../../voice/VoiceEngine",()=>({VoiceEngine:{speak:vi.fn()}}));
vi.mock("../../audio/AudioEngine",()=>({AudioEngine:{play:vi.fn(),bindGesture:vi.fn()}}));
vi.mock("../../audio/ambience",()=>({useAmbience:()=>{}}));
vi.mock("@workloom/ui",()=>({clientChineseText:(value:string,fallback:string)=>value||fallback}));

let root:Root;
let container:HTMLDivElement;
beforeEach(()=>{
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear();
  localStorage.setItem(`theater-ceremony-${new Date().toDateString()}`,"1");
  channels.theater={mode:"active",ceoName:"公司负责人",pendingByTier:{},latestBriefing:null,ticker:[],
    satellites:Array.from({length:40},(_,index)=>({id:`worker-${String(index).padStart(2,"0")}`,presetKey:"local-worker",name:`员工${index}`,grade:"正常"})),
    floor:{agents:Array.from({length:40},(_,index)=>({id:`worker-${String(index).padStart(2,"0")}`,presetKey:"local-worker",name:`员工${index}`,state:"idle"}))}};
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation((kind:string)=>kind==="2d"?({clearRect:()=>{},beginPath:()=>{},arc:()=>{},fill:()=>{}} as unknown as CanvasRenderingContext2D):({} as WebGLRenderingContext));
  vi.stubGlobal("requestAnimationFrame",()=>1);vi.stubGlobal("cancelAnimationFrame",()=>{});
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
const mount=()=>act(async()=>root.render(<P0/>));
const worker=(id="worker-00")=>container.querySelector<HTMLButtonElement>(`[data-worker-id="${id}"]`);
const focus=async(element:HTMLElement)=>act(async()=>element.focus());
const advance=(milliseconds:number)=>act(async()=>vi.advanceTimersByTimeAsync(milliseconds));

test("真正聚焦的员工经过12秒轮换仍保留DOM与身份，离开场景后继续轮换",async()=>{
  await mount();const original=worker()!;await focus(original);await advance(13_000);
  expect(original.isConnected).toBe(true);expect(worker()).toBe(original);expect(document.activeElement).toBe(original);
  await act(async()=>original.click());expect(channels.navigate).toHaveBeenLastCalledWith("/agents/worker-00");
  await focus([...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="职场")!);
  await advance(12_000);expect(worker()).toBeNull();expect(worker("worker-18")).toBeTruthy();
});

test("5秒投影重排保留当前批次ID但使用最新员工状态与文案",async()=>{
  await mount();const original=worker()!;await focus(original);
  channels.theater={...channels.theater,floor:{agents:channels.theater.floor.agents.map((agent,index)=>({...agent,state:index>=18?"asking":"idle",name:index===0?"同一员工的新文案":agent.name}))}};
  await advance(5_000);expect(worker()).toBe(original);expect(document.activeElement).toBe(original);expect(original.textContent).toBe("同一员工的新文案");
  await act(async()=>original.click());expect(channels.navigate).toHaveBeenLastCalledWith("/agents/worker-00");
});

test("舞台聚焦同样暂停换批，不把焦点换成员工的新身份",async()=>{
  await mount();await act(async()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="舞台")!.click());
  const original=worker()!;await focus(original);await advance(13_000);
  expect(worker()).toBe(original);expect(original.isConnected).toBe(true);expect(document.activeElement).toBe(original);
});

test("聚焦期间任务更新使用同一员工的最新任务ID，Escape释放后继续轮换",async()=>{
  channels.theater.floor.agents[0]={...channels.theater.floor.agents[0]!,currentThread:{id:"task-before",title:"旧任务"}};
  await mount();const original=worker()!;await focus(original);
  channels.theater={...channels.theater,floor:{agents:channels.theater.floor.agents.map((agent,index)=>index===0?{...agent,currentThread:{id:"task-after",title:"新任务"}}:agent)}};
  await advance(13_000);expect(worker()).toBe(original);expect(document.activeElement).toBe(original);
  await act(async()=>original.click());expect(channels.navigate).toHaveBeenLastCalledWith("/tasks/task-after");
  await act(async()=>original.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  await advance(12_000);expect(worker()).toBeNull();expect(worker("worker-18")).toBeTruthy();
});

test.each(["removed","disabled"])("被聚焦员工%s时释放批次并把焦点交给连接着的场景入口",async(status)=>{
  await mount();await focus(worker()!);
  channels.theater={...channels.theater,floor:{agents:status==="removed"?channels.theater.floor.agents.filter(agent=>agent.id!=="worker-00"):channels.theater.floor.agents.map(agent=>agent.id==="worker-00"?{...agent,state:"disabled"}:agent)}};
  await advance(5_000);expect(worker()).toBeNull();
  expect(document.activeElement?.textContent).toBe("职场");expect(document.activeElement?.isConnected).toBe(true);
  await advance(12_000);expect(worker("worker-19")).toBeTruthy();
});
