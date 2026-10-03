// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CeremonyStage, type CeremonyActor } from "./CeremonyStage";

// GPU 后端在此不是被测对象；正式 VectorCeremonyStage 与 AgentAvatarOf 保持真实实现。
vi.mock("@react-three/fiber", () => ({ Canvas: () => null, useFrame: () => {} }));
vi.mock("./BusinessAvatar3D", () => ({ BusinessAvatar3D: () => null }));
vi.mock("./cinematic", () => ({ CineFloor: () => null, SpotBeam: () => null, CinePost: () => null }));

let root: Root;
let container: HTMLDivElement;
const actorsOf = (count: number): CeremonyActor[] => Array.from({ length: count }, (_, index) => ({
  presetKey: index === 0 ? "company-ceo" : `test-member-${index}`,
  name: index === 0 ? "数字总经理" : `第${index}位数字员工`,
}));
const stage = () => container.querySelector<HTMLElement>('[data-ceremony-render-mode="vector2d"]')!;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 872 });
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("真实65人队列保留全部人物，只常驻总经理姓名，64个岗位均可聚焦查看", async () => {
  const actors = actorsOf(65);
  await act(async () => root.render(<CeremonyStage actors={actors} dancing={false} height="100%" />));
  expect(stage().dataset.ceremonyActors).toBe("65");
  expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(65);
  // 旧实现常驻65块姓名牌，固定两排导致每排姓名与人物相互覆盖。
  expect(container.querySelectorAll('[data-wl-meta]')).toHaveLength(1);
  const members = container.querySelectorAll<HTMLButtonElement>('button[data-ceremony-actor]');
  expect(members).toHaveLength(64);
  members.forEach((member, index) => expect(member.getAttribute("aria-label")).toContain(actors[index + 1]!.name));
  await act(async () => members[63]!.focus());
  expect(container.querySelector('[data-product-nameplate="ceremony-detail"]')?.textContent).toBe(actors[64]!.name);
  await act(async () => members[1]!.focus());
  expect(container.querySelectorAll('[data-product-nameplate="ceremony-detail"]')).toHaveLength(1);
  expect(container.querySelector('[data-product-nameplate="ceremony-detail"]')?.textContent).toBe(actors[2]!.name);
  await act(async () => members[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('[data-product-nameplate="ceremony-detail"]')).toBeNull();
});

test.each([1440, 768, 360])("宽度%d保留所有岗位，人物宽度小于实际队列单元，窄屏使用可滚动队列", async (width) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  await act(async () => root.render(<CeremonyStage actors={actorsOf(65)} height={460} />));
  const grid = container.querySelector<HTMLElement>('[data-ceremony-grid]');
  expect(grid).toBeTruthy();
  const columns = Number(stage().dataset.ceremonyColumns);
  expect(columns).toBeGreaterThanOrEqual(1);
  expect(columns).toBeLessThanOrEqual(16);
  expect(grid!.style.display).toBe("grid");
  const gridWidth = Number.parseFloat(grid!.style.width);
  const gap = Number.parseFloat(grid!.style.columnGap);
  const cellWidth = (gridWidth - gap * (columns - 1)) / columns;
  const members = grid!.querySelectorAll('button[data-ceremony-actor]');
  expect(members).toHaveLength(64);
  members.forEach((member) => {
    const avatar = member.querySelector("svg")!;
    expect(Number(avatar.getAttribute("width"))).toBeLessThanOrEqual(cellWidth - 8);
  });
  if (width === 360) {
    expect(stage().dataset.ceremonyScrollable).toBe("true");
    expect(grid!.style.overflowY).toBe("auto");
  }
});

test("详情槽避开实际总经理姓名高度，字体重排和长姓名不挤入人物队列", async () => {
  let ceoHeight = 154;
  let stageWidth = 1440;
  let stageHeight = 872;
  const observations: Array<{ element: Element; callback: ResizeObserverCallback }> = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { observations.push({ element, callback: this.callback }); }
    disconnect() {}
  });
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!.get!;
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.ceremonyActor === "company-ceo" ? ceoHeight : offsetHeight.call(this);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.ceremonyRenderMode !== "vector2d") return new DOMRect();
    return new DOMRect(0, 0, stageWidth, stageHeight);
  });
  const actors = actorsOf(65);
  actors[64]!.name = "一位完整岗位名称需要换行的数字员工".repeat(10);
  await act(async () => root.render(<CeremonyStage actors={actors} height="100%" dancing={false} />));
  const ceo = container.querySelector<HTMLElement>('[data-ceremony-actor="company-ceo"]')!;
  const member = container.querySelectorAll<HTMLButtonElement>('button[data-ceremony-actor]')[63]!;
  await act(async () => member.focus());
  const detail = () => container.querySelector<HTMLElement>('[data-product-nameplate="ceremony-detail"]')!;
  // jsdom 无字体布局：这里只在浏览器测量边界提供实际154px总经理高度，
  // 执行真实组件的测量/ResizeObserver/焦点链路，不把它当原生像素证据。
  const detailTop = () => {
    const slot = detail().closest<HTMLElement>("[data-ceremony-detail-slot]");
    return Number.parseFloat((slot?.parentElement ?? detail()).style.top);
  };
  expect(detailTop()).toBeGreaterThanOrEqual(Number.parseFloat(ceo.style.top) + ceoHeight + 12);
  const slot = detail().closest<HTMLElement>("[data-ceremony-detail-slot]")!;
  expect(slot.style.height).toBe("60px");
  expect(detail().style.position).not.toBe("absolute");
  expect(detail().style.maxHeight).toBe("60px");
  expect(detail().style.overflowY).toBe("auto");
  const originalGridHeight = container.querySelector<HTMLElement>("[data-ceremony-grid]")!.style.height;
  await act(async () => member.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('[data-product-nameplate="ceremony-detail"]')).toBeNull();
  expect(container.querySelector<HTMLElement>("[data-ceremony-grid]")!.style.height).toBe(originalGridHeight);
  await act(async () => member.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const initialTop = detailTop();
  ceoHeight = 210;
  await act(async () => observations.filter(({ element }) => element === ceo).forEach(({ callback }) => callback([], {} as ResizeObserver)));
  expect(detailTop()).toBe(initialTop + 56);
  expect(detailTop()).toBeGreaterThanOrEqual(Number.parseFloat(ceo.style.top) + ceoHeight + 12);
  stageWidth = 360;
  stageHeight = 460;
  ceoHeight = 112;
  await act(async () => observations.filter(({ element }) => element === stage()).forEach(({ callback }) => callback([], {} as ResizeObserver)));
  expect(detailTop()).toBeGreaterThanOrEqual(Number.parseFloat(ceo.style.top) + ceoHeight + 12);
  expect(stage().dataset.ceremonyScrollable).toBe("true");
});

test.each([[1, 580], [8, 755], [65, 1180]])("%d人的ready在最后一位入场完成%dms时才变绿", async (count, duration) => {
  const ready = vi.fn();
  await act(async () => root.render(<CeremonyStage actors={actorsOf(count)} dancing={false} onReady={ready} />));
  await act(async () => vi.advanceTimersByTime(duration - 1));
  expect(stage().dataset.ceremonyReady).toBe("false");
  expect(ready).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  expect(stage().dataset.ceremonyReady).toBe("true");
  expect(ready).toHaveBeenCalledTimes(1);
});

test("换成另一组岗位重置ready，舞蹈状态变化不重播完成回调，空队列不假装有成员", async () => {
  const ready = vi.fn();
  await act(async () => root.render(<CeremonyStage actors={actorsOf(65)} dancing={false} onReady={ready} />));
  await act(async () => vi.advanceTimersByTime(1180));
  expect(ready).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<CeremonyStage actors={actorsOf(5)} dancing={false} onReady={ready} />));
  expect(stage().dataset.ceremonyReady).toBe("false");
  await act(async () => vi.advanceTimersByTime(680));
  expect(ready).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<CeremonyStage actors={actorsOf(5)} dancing onReady={ready} />));
  await act(async () => vi.advanceTimersByTime(2000));
  expect(ready).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<CeremonyStage actors={[]} onReady={ready} />));
  await act(async () => vi.advanceTimersByTime(1));
  expect(stage().dataset.ceremonyActors).toBe("0");
  expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(0);
  expect(stage().dataset.ceremonyReady).toBe("true");
});
