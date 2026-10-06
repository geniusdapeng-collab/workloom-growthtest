// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LoomMate } from "./LoomMate";

const route = vi.hoisted(() => ({ pathname: "/" }));
const layout = vi.hoisted(() => ({ rail: 320, nav: 200 }));
const channels = vi.hoisted(() => ({
  items: [] as Array<{ id: string; kind: string; level: string; title: string; body: string; actions: Array<{label:string;link:string}>; link: string | null }>,
  inbox: vi.fn(), mark: vi.fn(), navigate: vi.fn(), speak: vi.fn(), login: vi.fn(), scan: vi.fn(),
}));
vi.mock("react-router", () => ({ useNavigate: () => channels.navigate, useLocation: () => route }));
vi.mock("../../lib/useAskRail", () => ({ useAskRailPadding: () => layout.rail, useSideNavWidth: () => layout.nav }));
vi.mock("../../shell/NavMenu", () => ({ canonicalNavigationPath: (path: string) => path.replace("/p1/", "/tasks/") }));
vi.mock("../../lib/trpc", () => ({
  ensureDemoLogin: () => channels.login(),
  trpc: {
    service: { secretary: {
      settings: { query: async () => ({ settings: { widget_size: "large", voice_on: false } }) },
      inbox: { query: () => channels.inbox() }, markInbox: { mutate: (input: unknown) => channels.mark(input) },
      scan: { mutate: () => channels.scan() },
    } },
    video: { studio: { active: { query: async () => ({ activeRuns: 0, pendingApprovals: 0, failedRecent: 0 }) } } },
    threads: { settledSince: { query: async () => [] } },
  },
}));
vi.mock("../../voice/VoiceEngine", () => ({ VoiceEngine: { speak: (input: unknown) => channels.speak(input) } }));
vi.mock("../../voice/mateVoice", () => ({ mateVoiceProfileOf: () => ({ female: true }) }));
vi.mock("../../audio/AudioEngine", () => ({ AudioEngine: { play: vi.fn() } }));
vi.mock("./MateLive2D", () => ({ MateLive2D: () => <div data-test-avatar="true" /> }));
vi.mock("../loomball", () => ({ LoomBall: () => <span />, loomBallEnabled: false,
  emotionLabelOf: () => "待机", emotionOfSystem: () => "02", useStableEmotion: (value: string) => value }));
// Keep the installed shared surface hook real: these tests exercise its actual
// nonmodal Escape stack and return-focus behavior, with a controlled avatar/API.
vi.mock("@workloom/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workloom/ui")>();
  return { ...actual, Icon: () => <span />, clientChineseText: (value: string) => value,
    clientValueText: (value: string) => value };
});

let root: Root;
let container: HTMLDivElement;
const makeItems = (count = 3) => Array.from({length:count}, (_, index) => ({
  id: `notice-${index}`, kind: index === 0 ? "daily" : "alert", level: index === 0 ? "low" : index === 1 ? "high" : "red",
  title: `本地通知${index}`, body: `可复核的通知正文${index}`, actions: [{label:"查看任务",link:"/p1/inbox-task"}],
  link: "/p1/inbox-task",
}));
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  channels.login.mockResolvedValue(undefined);
  channels.inbox.mockImplementation(async () => ({items: channels.items}));
  channels.mark.mockResolvedValue(undefined);
  channels.scan.mockResolvedValue({added:0});
  channels.items = makeItems();
  localStorage.clear(); route.pathname = "/"; layout.rail = 320; layout.nav = 200;
  Object.defineProperty(window, "innerWidth", {configurable:true,value:1440});
  Object.defineProperty(window, "innerHeight", {configurable:true,value:872});
  vi.stubGlobal("matchMedia", () => ({ matches:false,addEventListener:()=>{},removeEventListener:()=>{} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGLRenderingContext);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const mount = () => act(async () => root.render(<LoomMate />));
const press = (element: HTMLElement) => act(async () => element.click());
const toggle = () => container.querySelector<HTMLButtonElement>("[data-loommate-inbox-toggle]")!;
const tray = () => container.querySelector<HTMLElement>("[data-loommate-inbox-tray]");
const open = async () => { expect(toggle()).toBeTruthy(); await press(toggle()); expect(tray()).toBeTruthy(); };
const body = () => container.querySelector<HTMLElement>("[data-loommate-mode]")!;

test.each([360, 1440, 2880].flatMap(width => [null, "0", "1"].map(preference => [width, preference] as const)))
  ("宽度%d与形态偏好%s恢复三条通知时只显示入口，场景不自动覆盖", async (width, preference) => {
    Object.defineProperty(window, "innerWidth", {configurable:true,value:width});
    if(width===360){layout.nav=0;layout.rail=0;}
    if(preference!==null)localStorage.setItem("loommate.mini",preference);
    await mount();
    expect(tray()).toBeNull(); expect(container.textContent).not.toContain("可复核的通知正文");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toContain("3条未读通知");
    expect(toggle().getAttribute("aria-label")).toContain("2条需关注");
    expect(toggle().parentElement?.closest("button")).toBeNull();
    expect(localStorage.getItem("loommate.mini")).toBe(preference);
    expect(channels.mark).not.toHaveBeenCalled();
  });

test("明确打开和关闭托盘保持小球本体及偏好，并恢复入口焦点", async () => {
  localStorage.setItem("loommate.mini","1"); await mount();
  const initial = {right:body().style.right,bottom:body().style.bottom,width:body().style.width};
  const entry=toggle(); entry.focus(); await open();
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(tray()!.style.maxHeight).not.toBe(""); expect(tray()!.style.overflowY).toBe("auto");
  expect(Number.parseFloat(tray()!.style.marginBottom)).toBeGreaterThanOrEqual(56);
  expect(tray()!.textContent).toContain("可复核的通知正文2");
  expect({right:body().style.right,bottom:body().style.bottom,width:body().style.width}).toEqual(initial);
  expect(body().dataset.loommateMode).toBe("mini");
  await press(container.querySelector<HTMLElement>('[aria-label="关闭通知"]')!);
  expect(tray()).toBeNull(); expect(document.activeElement).toBe(entry);
  expect(localStorage.getItem("loommate.mini")).toBe("1"); expect(channels.mark).not.toHaveBeenCalled();
});

test("共享非模态栈的Escape只关闭通知并还焦点，背景没有inert或滚动锁", async () => {
  await mount(); const entry=toggle(); entry.focus(); await open();
  expect(container.hasAttribute("inert")).toBe(false); expect(document.body.style.overflow).not.toBe("hidden");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  expect(tray()).toBeNull(); expect(document.activeElement).toBe(entry);
  expect(body().dataset.loommateMode).toBe("mini");
});

test("隐藏唤回和路由改变关闭托盘，保留未读项与显式形态", async () => {
  localStorage.setItem("loommate.mini","1"); await mount(); await open();
  await press(container.querySelector<HTMLElement>('[aria-label="隐藏织伴"]')!);
  await press(container.querySelector<HTMLElement>('button[title="唤回小织"]')!);
  expect(tray()).toBeNull(); expect(toggle().getAttribute("aria-label")).toContain("3条未读通知");
  await open(); route.pathname="/tasks"; await mount(); expect(tray()).toBeNull();
  expect(localStorage.getItem("loommate.mini")).toBe("1"); expect(channels.mark).not.toHaveBeenCalled();
});

test("轮询增加未读和紧急数时不自动展开，完成字幕继续可见", async () => {
  vi.useFakeTimers(); await mount(); channels.items=makeItems(4);
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(toggle().getAttribute("aria-label")).toContain("4条未读通知"); expect(tray()).toBeNull();
  await act(async () => window.dispatchEvent(new CustomEvent("workloom:task-settled",{detail:{threadId:"local-task",title:"本地任务已完成",status:"completed"}})));
  expect(tray()).toBeNull(); expect(container.querySelector('[role="status"]')?.textContent).toContain("本地任务已完成");
  expect(channels.speak).toHaveBeenCalled(); expect(localStorage.getItem("loommate.mini")).toBeNull();
});

test.each(["read","acted"])("通知%s更新失败保留该项并给重试出口，成功才移除和导航", async status => {
  channels.mark.mockRejectedValueOnce(new Error("测试故障，不可对用户泄漏的上游字段"));
  await mount(); await open();
  const item=()=>container.querySelector<HTMLElement>('[data-loommate-inbox-item="notice-0"]')!;
  const action=()=>[...item().querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===(status==="read"?"稍后":"查看任务"))!;
  await press(action()); expect(item()).toBeTruthy(); expect(item().querySelector('[role="alert"]')?.textContent).toContain("通知未能更新");
  expect(container.textContent).not.toContain("上游字段"); expect(channels.navigate).not.toHaveBeenCalled();
  await press(action()); expect(container.querySelector('[data-loommate-inbox-item="notice-0"]')).toBeNull();
  expect(channels.mark).toHaveBeenLastCalledWith({ids:["notice-0"],status});
  if(status==="acted")expect(channels.navigate).toHaveBeenCalledWith("/tasks/inbox-task"); else expect(channels.navigate).not.toHaveBeenCalled();
});

test("待确认的通知更新禁用该项按钮且不重复提交", async () => {
  let resolve!:()=>void; channels.mark.mockImplementationOnce(()=>new Promise<void>(done=>{resolve=done;}));
  await mount(); await open();
  const item=container.querySelector<HTMLElement>('[data-loommate-inbox-item="notice-0"]')!;
  const button=[...item.querySelectorAll<HTMLButtonElement>("button")].find(node=>node.textContent==="稍后")!;
  await press(button); expect(button.disabled).toBe(true); await press(button); expect(channels.mark).toHaveBeenCalledTimes(1);
  await act(async()=>resolve()); expect(container.querySelector('[data-loommate-inbox-item="notice-0"]')).toBeNull();
});

test("读取失败不把旧提醒清空为无事，入口和托盘显示可重试状态", async () => {
  vi.useFakeTimers(); await mount(); channels.inbox.mockRejectedValueOnce(new Error("读故障"));
  await act(async()=>vi.advanceTimersByTimeAsync(20_000));
  expect(toggle().getAttribute("aria-label")).toContain("3条未读通知"); await open();
  expect(tray()!.querySelector('[role="alert"]')?.textContent).toContain("通知暂时无法读取");
  const retry=[...tray()!.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="重试读取")!;
  expect(retry).toBeTruthy(); await press(retry);
  expect(tray()!.querySelector('[role="alert"]')).toBeNull(); expect(tray()!.textContent).toContain("可复核的通知正文2");
});

test("超过前三条的未读均有查看路径，达到服务端上限时数量标为至少", async () => {
  channels.items=makeItems(50); await mount(); expect(toggle().getAttribute("aria-label")).toContain("至少50条未读通知");
  await open(); expect(container.querySelectorAll('[data-loommate-inbox-item]')).toHaveLength(50);
  expect(tray()!.textContent).toContain("最近50条");
});

test("成功确认后的迟到旧收件箱响应不能复活同一条通知", async () => {
  vi.useFakeTimers(); await mount(); await open();
  const oldItems=channels.items.slice(); let resolve!:(value:{items:typeof oldItems})=>void;
  channels.inbox.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  await act(async()=>vi.advanceTimersByTimeAsync(20_000));
  const item=container.querySelector<HTMLElement>('[data-loommate-inbox-item="notice-0"]')!;
  await press([...item.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="稍后")!);
  await act(async()=>resolve({items:oldItems})); expect(container.querySelector('[data-loommate-inbox-item="notice-0"]')).toBeNull();
  expect(toggle().getAttribute("aria-label")).toContain("2条未读通知");
});

test("空收件箱仍有明确入口和空态，打开本身不提交已读", async () => {
  channels.items=[]; await mount(); expect(toggle().getAttribute("aria-label")).toContain("0条未读通知");
  await open(); expect(tray()!.textContent).toContain("暂无未读通知"); expect(channels.mark).not.toHaveBeenCalled();
});

test("登录失败保留已收到事项并允许重试，不出现未处理拒绝", async () => {
  vi.useFakeTimers(); await mount(); channels.login.mockRejectedValue(new Error("401 upstream credentials"));
  await act(async()=>vi.advanceTimersByTimeAsync(20_000)); await open();
  expect(toggle().getAttribute("aria-label")).toContain("3条未读通知");
  expect(tray()!.querySelector('[role="alert"]')?.textContent).toContain("通知暂时无法读取");
  expect(container.textContent).not.toContain("credentials");
  channels.login.mockResolvedValue(undefined);
  await press([...tray()!.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="重试读取")!);
  expect(tray()!.querySelector('[role="alert"]')).toBeNull();
});

test("事件扫描失败仍读取已有通知，扫描恢复后刷新清除提示", async () => {
  vi.useFakeTimers(); await mount(); channels.items=makeItems(4);
  channels.scan.mockRejectedValueOnce(new Error("scan unavailable"));
  await act(async()=>vi.advanceTimersByTimeAsync(20_000)); await open();
  expect(toggle().getAttribute("aria-label")).toContain("4条未读通知");
  expect(tray()!.querySelector('[role="alert"]')?.textContent).toContain("通知扫描暂时无法更新");
  await press([...tray()!.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="刷新")!);
  expect(tray()!.querySelector('[role="alert"]')).toBeNull(); expect(channels.mark).not.toHaveBeenCalled();
});

test("路由自动关闭真实共享表面时不抢走新页面控件的焦点", async () => {
  await mount(); await open(); expect(document.activeElement).toBe(container.querySelector('[aria-label="关闭通知"]'));
  const destination=document.createElement("button"); destination.textContent="新页面入口";document.body.append(destination);
  try {
    destination.focus(); route.pathname="/tasks"; await mount();
    expect(tray()).toBeNull(); expect(document.activeElement).toBe(destination); expect(channels.mark).not.toHaveBeenCalled();
  } finally {destination.remove();}
});

test("显式改变小球形态关闭托盘而不清未读，完成字幕不叠盖托盘", async () => {
  localStorage.setItem("loommate.mini","1"); await mount(); await open();
  await act(async()=>window.dispatchEvent(new CustomEvent("workloom:task-settled",{detail:{threadId:"same-local-task",title:"完成字幕",status:"completed"}})));
  expect(container.querySelectorAll('[data-loommate-notices]')).toHaveLength(1);
  expect(tray()!.querySelector('[role="status"]')?.textContent).toContain("完成字幕");
  await press([...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.title.startsWith("展开"))!);
  expect(tray()).toBeNull(); expect(toggle().getAttribute("aria-label")).toContain("3条未读通知");
  expect(localStorage.getItem("loommate.mini")).toBe("0");expect(channels.mark).not.toHaveBeenCalled();
});
