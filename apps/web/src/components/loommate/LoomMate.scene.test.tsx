// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LoomMate } from "./LoomMate";

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn(), useLocation: () => route }));
vi.mock("../../lib/useAskRail", () => ({ useAskRailPadding: () => 320, useSideNavWidth: () => 200 }));
vi.mock("../../shell/NavMenu", () => ({ canonicalNavigationPath: (path: string) => path }));
vi.mock("../../lib/trpc", () => ({
  ensureDemoLogin: async () => {},
  trpc: {
    service: { secretary: {
      settings: { query: async () => ({ settings: { widget_size: "large", voice_on: false } }) },
      inbox: { query: async () => ({ items: [] }) },
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
