// @vitest-environment jsdom
import { act, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Floor3D } from "../../components/Floor3D";
import type { FloorAgent, FloorPayload } from "../../pages/p0/Floor";

const gaze = vi.hoisted(() => new Map<string, { onGaze: () => void }>());
// 正式 Worker 与其 HTML 内容保持真实实现；GPU/三维投影边界另由 native 验收负责。
vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: PropsWithChildren) => <div>{children}</div>,
  useFrame: () => {}, useThree: () => ({ camera: { position: { clone: () => ({}) } } }),
}));
vi.mock("@react-three/drei", () => ({
  OrbitControls: () => null,
  Html: ({ children, distanceFactor }: PropsWithChildren<{ distanceFactor?: number }>) => (
    <div data-test-html data-test-distance-factor={distanceFactor ?? "fixed"}>{children}</div>
  ),
}));
vi.mock("../../components/BusinessAvatar3D", () => ({ BusinessAvatar3D: () => null }));
vi.mock("../../components/GazeSystem", () => ({
  GazeSystem: () => null,
  GazeRegistry: { register: (entry: { id: string; onGaze: () => void }) => {
    gaze.set(entry.id, entry);
    return () => { gaze.delete(entry.id); };
  } },
}));
vi.mock("./HoverBubble", () => ({ HoverBubble: ({ text, visible }: { text: string; visible: boolean }) => visible ? <div data-test-separate-bubble>{text}</div> : null }));
vi.mock("../../components/CineDirector", () => ({ CineDirector: () => null, FuseVignette: () => null }));
vi.mock("../../audio/AudioEngine", () => ({ AudioEngine: { play: vi.fn() } }));
vi.mock("../../lib/useNightTime", () => ({ useNightTime: () => false }));
vi.mock("../../components/cinematic", () => ({
  CineFloor: () => null, SpotBeam: () => null, CineRig: () => null, CinePost: () => null,
  SkyDome: () => null, Skyline: () => null, NamePlate: () => null, DustMotes: () => null,
}));

let root: Root;
let container: HTMLDivElement;
const onOpenTask = vi.fn();
const onOpenProfile = vi.fn();
const agentsOf = (): FloorAgent[] => [
  { id: "worker-task", name: "数字内容负责人", state: "working", currentThread: { id: "task-123", title: "整理今天的内容发布计划" } },
  { id: "worker-idle", name: "数字客户经理", state: "idle", currentThread: null },
  { id: "worker-disabled", name: "已停用岗位", state: "disabled", currentThread: null },
].map((agent) => ({
  ...agent, state: agent.state as FloorAgent["state"], presetKey: agent.id, stationId: "desk-1",
  pendingTier: null, approvalId: null, statusLine: `${agent.name}的真实状态说明可查看，不应被压成逐字竖排。`,
}));
const floorOf = (): FloorPayload => ({
  agents: agentsOf(),
  scene: {
    id: "scene-test", name: "测试职场", theme: { floorA: "#000", floorB: "#000", wall: "#000", accent: "#fff", night: false },
    grid: { w: 8, h: 6 }, stations: [{ id: "desk-1", x: 3, y: 3, kind: "desk" }], props: [],
    ceoDesk: { x: 4, y: 1 }, lounge: { x: 6, y: 4 }, entrance: { x: 1, y: 5 },
  },
});
const renderFloor = async (floor = floorOf()) => act(async () => root.render(
  <Floor3D floor={floor} ceoName="数字总经理" onOpenProfile={onOpenProfile} onOpenTask={onOpenTask} onPickAgent={vi.fn()} />,
));
const cardOf = (id: string) => container.querySelector<HTMLButtonElement>(`[data-product-nameplate="worker"][data-worker-id="${id}"]`)
  ?? [...container.querySelectorAll<HTMLButtonElement>('[data-product-nameplate="worker"]')].find((card) => card.textContent?.includes(id === "worker-task" ? "数字内容负责人" : "数字客户经理"));

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  onOpenTask.mockClear();
  onOpenProfile.mockClear();
  gaze.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("员工卡HTML拥有确定宽度与12px字号，不随相机距离缩成逐字竖排，任务点击保留真实id", async () => {
  await renderFloor();
  const card = cardOf("worker-task")!;
  expect(card).toBeTruthy();
  expect(Number.parseFloat(card.parentElement!.style.width)).toBeGreaterThanOrEqual(160);
  expect(card.closest<HTMLElement>('[data-test-html]')!.dataset.testDistanceFactor).toBe("fixed");
  expect(Number.parseFloat(card.querySelector("span")!.style.fontSize)).toBeGreaterThanOrEqual(12);
  expect(card.style.width).toBe("100%");
  await act(async () => card.click());
  expect(onOpenTask).toHaveBeenCalledWith("task-123");
  expect(onOpenProfile).not.toHaveBeenCalled();
  const longFloor = floorOf();
  longFloor.agents[0]!.currentThread!.title = "内容计划".repeat(80);
  longFloor.agents[0]!.statusLine = "完整中文状态说明".repeat(120);
  await renderFloor(longFloor);
  await act(async () => gaze.get("worker-task")!.onGaze());
  const status = container.querySelector<HTMLElement>('[data-worker-status="worker-task"]')!;
  expect(status.textContent).toBe(longFloor.agents[0]!.statusLine);
  expect(status.style.maxHeight).toBe("72px");
  expect(status.style.overflowY).toBe("auto");
  expect(cardOf("worker-task")!.querySelector("span:nth-child(2)")!.textContent).toContain(longFloor.agents[0]!.currentThread!.title);
});

test("注视状态只在同一张员工卡展开，没有第二张重叠气泡，超时后回到任务卡", async () => {
  await renderFloor();
  await act(async () => gaze.get("worker-task")!.onGaze());
  expect(container.querySelectorAll('[data-test-separate-bubble]')).toHaveLength(0);
  const status = container.querySelector('[data-worker-status="worker-task"]');
  expect(status?.textContent).toContain("真实状态说明");
  expect(status?.closest('[data-product-nameplate="worker"]')).toBe(cardOf("worker-task"));
  await act(async () => vi.advanceTimersByTime(4000));
  expect(container.querySelector('[data-worker-status="worker-task"]')).toBeNull();
  expect(cardOf("worker-task")!.dataset.workerCardVisible).toBe("true");
});

test("待命岗位可用Tab聚焦展开卡片，回车原生点击打开档案，Escape收起；停用岗位不产生入口", async () => {
  await renderFloor();
  const card = cardOf("worker-idle");
  expect(card).toBeTruthy();
  expect(card!.dataset.workerCardVisible).toBe("false");
  await act(async () => card!.focus());
  expect(cardOf("worker-idle")!.dataset.workerCardVisible).toBe("true");
  expect(container.querySelector('[data-worker-status="worker-idle"]')?.textContent).toContain("真实状态说明");
  await act(async () => card!.click());
  expect(onOpenProfile).toHaveBeenCalledWith(expect.objectContaining({ id: "worker-idle" }));
  await act(async () => card!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(cardOf("worker-idle")!.dataset.workerCardVisible).toBe("false");
  expect(container.querySelector('[data-product-nameplate="worker"][data-worker-id="worker-disabled"]')).toBeNull();
});

test("状态内容保留中文显示边界，连续注视刷新关闭计时，卸载取消挂起计时器", async () => {
  const floor = floorOf();
  floor.agents[0]!.statusLine = "SELECT tenant_id FROM secrets";
  await renderFloor(floor);
  await act(async () => gaze.get("worker-task")!.onGaze());
  expect(container.querySelector('[data-worker-status="worker-task"]')?.textContent).toBe("当前状态待确认");
  await act(async () => vi.advanceTimersByTime(3000));
  await act(async () => gaze.get("worker-task")!.onGaze());
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.querySelector('[data-worker-status="worker-task"]')).toBeTruthy();
  await act(async () => root.render(<></>));
  expect(gaze.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
