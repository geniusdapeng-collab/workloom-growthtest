// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LoomMate } from "./LoomMate";

const route = vi.hoisted(() => ({ pathname: "/" }));
const layout = vi.hoisted(() => ({ rail: 320, nav: 200 }));
const inbox = vi.hoisted(() => ({ items: [] as Array<{ id: string; kind: string; level: string; title: string; body: string; actions: Array<{ label: string; link: string }>; link: null }> }));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn(), useLocation: () => route }));
vi.mock("../../lib/useAskRail", () => ({ useAskRailPadding: () => layout.rail, useSideNavWidth: () => layout.nav }));
vi.mock("../../shell/NavMenu", () => ({ canonicalNavigationPath: (path: string) => path }));
vi.mock("../../lib/trpc", () => ({
  ensureDemoLogin: async () => {},
  trpc: {
    service: { secretary: {
      settings: { query: async () => ({ settings: { widget_size: "large", voice_on: false } }) },
      inbox: { query: async () => ({ items: inbox.items }) },
      scan: { mutate: async () => ({ added: 0 }) },
    } },
    video: { studio: { active: { query: async () => ({ activeRuns: 0, pendingApprovals: 0, failedRecent: 0 }) } } },
    threads: { settledSince: { query: async () => [] } },
  },
}));
vi.mock("../../voice/VoiceEngine", () => ({ VoiceEngine: { speak: vi.fn() } }));
vi.mock("../../voice/mateVoice", () => ({ mateVoiceProfileOf: () => ({ female: true }) }));
vi.mock("../../audio/AudioEngine", () => ({ AudioEngine: { play: vi.fn() } }));
vi.mock("./MateLive2D", () => ({ MateLive2D: () => <div data-test-avatar="true" /> }));
vi.mock("../loomball", () => ({
  LoomBall: () => <span />, loomBallEnabled: false,
  emotionLabelOf: () => "待机", emotionOfSystem: () => "02", useStableEmotion: (emotion: string) => emotion,
}));
vi.mock("@workloom/ui", () => ({
  Icon: () => <span />, clientChineseText: (value: string) => value, clientValueText: (value: string) => value,
  useManagedSurface: () => ({}),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  route.pathname = "/";
  layout.rail = 320;
  layout.nav = 200;
  inbox.items = [];
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as WebGLRenderingContext);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const miniButton = () => [...container.querySelectorAll("button")].find((button) => button.title.startsWith("展开"));
const settleTask = async () => act(async () => {
  window.dispatchEvent(new CustomEvent("workloom:task-settled", {
    detail: { threadId: "scene-test-task", title: "本地测试任务", status: "completed" },
  }));
});

test("经营主页默认角落形态给中央场景留出空间，其他宽内容页保持大形象", async () => {
  await act(async () => root.render(<LoomMate />));
  expect(miniButton()).toBeTruthy();
  expect(localStorage.getItem("loommate.mini")).toBeNull();
  route.pathname = "/tasks";
  await act(async () => root.render(<LoomMate />));
  expect(miniButton()).toBeUndefined();
  expect(container.querySelector('[data-test-avatar="true"]')).toBeTruthy();
});

test("任务通知保留用户收起偏好，并在小球态给出可见字幕", async () => {
  localStorage.setItem("loommate.mini", "1");
  await act(async () => root.render(<LoomMate />));
  await settleTask();
  expect(miniButton()).toBeTruthy();
  expect(localStorage.getItem("loommate.mini")).toBe("1");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("本地测试任务");
});

test("用户显式展开仍生效，自动通知不改写其偏好", async () => {
  localStorage.setItem("loommate.mini", "0");
  await act(async () => root.render(<LoomMate />));
  expect(miniButton()).toBeUndefined();
  await settleTask();
  expect(localStorage.getItem("loommate.mini")).toBe("0");
});

test.each([null, "1", "0"])("引导暂时隐藏后恢复可见保留形态偏好 %s", async (preference) => {
  if (preference !== null) localStorage.setItem("loommate.mini", preference);
  await act(async () => root.render(<LoomMate />));
  await act(async () => {
    window.dispatchEvent(new CustomEvent("workloom:loommate-visibility", { detail: "hide" }));
  });
  await act(async () => {
    window.dispatchEvent(new CustomEvent("workloom:loommate-visibility", { detail: "show" }));
  });
  expect(Boolean(miniButton())).toBe(preference !== "0");
  expect(localStorage.getItem("loommate.mini")).toBe(preference);
  expect(localStorage.getItem("loommate.hidden")).toBe("0");
});

const companionRoot = () => container.querySelector<HTMLElement>('[data-loommate-mode="mini"], [data-loommate-mode="expanded"]')
  ?? (miniButton()?.parentElement?.parentElement as HTMLElement | undefined)
  ?? (container.firstElementChild as HTMLElement);
const click = async (button: HTMLElement) => act(async () => button.click());

test.each([1440, 360])("宽度%d的小球隐藏和唤回仍保持默认右下角，不凭大形象生成坐标", async (width) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  if (width === 360) { layout.nav = 0; layout.rail = 0; }
  localStorage.setItem("loommate.mini", "1");
  await act(async () => root.render(<LoomMate />));
  expect(companionRoot()!.style.right).toBe(`${layout.rail + 16}px`);
  expect(companionRoot()!.style.bottom).toBe("16px");
  await click(container.querySelector('[aria-label="隐藏织伴"]')!);
  await click(container.querySelector('button[title="唤回小织"]')!);
  expect(miniButton()).toBeTruthy();
  expect(companionRoot()!.style.right).toBe(`${layout.rail + 16}px`);
  expect(companionRoot()!.style.bottom).toBe("16px");
  expect(companionRoot()!.style.left).toBe("");
  expect(companionRoot()!.style.top).toBe("");
  expect(localStorage.getItem("loommate.pos")).toBeNull();
  expect(localStorage.getItem("loommate.mini")).toBe("1");
});

test("展开态两个隐藏出口都保留默认锚点，唤回后用户选择的大形象仍生效", async () => {
  localStorage.setItem("loommate.mini", "0");
  await act(async () => root.render(<LoomMate />));
  for (const exit of ["avatar", "bar"]) {
    const hide = exit === "avatar"
      ? container.querySelector<HTMLElement>('[aria-label="隐藏织伴"]')
      : [...container.querySelectorAll("button")].find((button) => button.textContent === "隐藏");
    expect(hide).toBeTruthy();
    await click(hide!);
    await click(container.querySelector('button[title="唤回小织"]')!);
    expect(miniButton()).toBeUndefined();
    expect(companionRoot()!.style.right).toBe("336px");
    expect(companionRoot()!.style.bottom).toBe("16px");
    expect(localStorage.getItem("loommate.pos")).toBeNull();
  }
});

test("保存的小球位置按64px本体钳制，隐藏把手80px仍在屏内，通知不参与本体尺寸", async () => {
  localStorage.setItem("loommate.mini", "1");
  localStorage.setItem("loommate.pos", JSON.stringify({ x: 1040, y: 820 }));
  inbox.items = [{ id: "notice-1", kind: "alert", level: "high", title: "请检查待办", body: "这是可复核的测试通知", actions: [], link: null }];
  await act(async () => root.render(<LoomMate />));
  expect(companionRoot()!.style.left).toBe("1040px");
  expect(companionRoot()!.style.top).toBe("820px");
  expect(companionRoot()!.style.width).toBe("64px");
  const notices = container.querySelector<HTMLElement>('[data-loommate-notices]');
  expect(notices).toBeTruthy();
  expect(notices!.style.position).toBe("absolute");
  expect(notices!.style.maxHeight).not.toBe("");
  await settleTask();
  expect(companionRoot()!.style.left).toBe("1040px");
  expect(companionRoot()!.style.top).toBe("820px");
  expect(container.querySelector('[role="status"]')?.closest('[data-loommate-notices]')).toBe(notices);
  await click(container.querySelector('[aria-label="隐藏织伴"]')!);
  const handle = container.querySelector<HTMLElement>('button[title="唤回小织"]')!;
  expect(Number.parseFloat(handle.style.top)).toBeLessThanOrEqual(820);
  await click(handle);
  expect(companionRoot()!.style.top).toBe("820px");
  expect(localStorage.getItem("loommate.pos")).toBe(JSON.stringify({ x: 1040, y: 820 }));
});

test("左侧保存位置与显式偏好经过hide/show/toggle和视口缩小后仍有可达出口", async () => {
  localStorage.setItem("loommate.mini", "1");
  localStorage.setItem("loommate.pos", JSON.stringify({ x: 216, y: 810 }));
  await act(async () => root.render(<LoomMate />));
  expect(companionRoot()!.style.left).toBe("216px");
  expect(companionRoot()!.style.top).toBe("810px");
  await act(async () => window.dispatchEvent(new CustomEvent("workloom:loommate-visibility", { detail: "toggle" })));
  expect(container.querySelector<HTMLElement>('button[title="唤回小织"]')!.style.left).toBe("200px");
  await act(async () => window.dispatchEvent(new CustomEvent("workloom:loommate-visibility", { detail: "show" })));
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(Number.parseFloat(companionRoot()!.style.top)).toBeLessThanOrEqual(636);
  expect(localStorage.getItem("loommate.mini")).toBe("1");
  await click(container.querySelector('[aria-label="隐藏织伴"]')!);
  const handle = container.querySelector<HTMLElement>('button[title="唤回小织"]')!;
  expect(Number.parseFloat(handle.style.top)).toBeLessThanOrEqual(620);
});

test.each(["null", "[]", '{"x":"right","y":10}', '{"x":1e309,"y":10}'])("无效保存坐标%s回落默认停靠，不生成NaN位置", async (position) => {
  localStorage.setItem("loommate.mini", "1");
  localStorage.setItem("loommate.pos", position);
  await act(async () => root.render(<LoomMate />));
  expect(companionRoot()!.style.right).toBe("336px");
  expect(companionRoot()!.style.bottom).toBe("16px");
  expect(companionRoot()!.style.left).toBe("");
  expect(companionRoot()!.style.top).toBe("");
});
