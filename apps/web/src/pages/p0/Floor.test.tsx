// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import scene from "../../../../../bundles/geo-growth/floor-scene.json";
import { FloorView, type FloorAgent } from "./Floor";
import { createFloorLayout } from "./floor-layout";

describe("职场真实组件的首帧与点击分派", () => {
  let root: Root;
  let host: HTMLDivElement;
  let clock: number;
  let width: number;
  let frames: Map<number, FrameRequestCallback>;
  let texts: Array<{ text: string; x: number; y: number; font: string }>;
  let cards: Array<{ x: number; y: number; width: number; height: number }>;
  let bodies: Array<{ x: number; y: number }>;
  const profile = vi.fn(), task = vi.fn();
  let nextFrame: number;
  let unavailable = false;
  let contentSafety = false;

  function team(count = 18, state: FloorAgent["state"] = "idle"): FloorAgent[] {
    return Array.from({ length: count }, (_, index) => ({ id: `person-${index}`, presetKey: `person-role-${index}`, name: `客户成功官${"甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未"[index]}`,
      state, stationId: null, currentThread: state === "working" || state === "queued" ? { id: `job-${index}`, title: "客户特殊素材复核与内容产物的完整说明" } : null,
      pendingTier: null, approvalId: null, statusLine: "本地组件回归" }));
  }
  async function render(list: FloorAgent[]) {
    await act(async () => root.render(<FloorView floor={{ scene, agents: list }} ceoName="公司负责人" onPickAgent={profile} onOpenProfile={profile} onOpenTask={task} />));
  }
  async function advance(seconds = 1 / 60) {
    clock += seconds * 1000;
    const pending = [...frames.values()]; frames.clear();
    await act(async () => { for (const callback of pending) callback(clock); });
  }
  function canvas() { return host.querySelector("canvas")!; }
  async function click(x: number, y: number) {
    await act(async () => canvas().dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y })));
  }
  async function hover(x: number, y: number) {
    await act(async () => canvas().dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })));
    await advance();
  }
  const slotsOf = (list: FloorAgent[]) => createFloorLayout({ scene, agents: list }, width, 440, canvas().getContext("2d")!).slots;
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    clock = 0; width = 768; frames = new Map(); nextFrame = 0; texts = []; cards = []; bodies = []; unavailable = false; contentSafety = false;
    profile.mockClear(); task.mockClear();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(440);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLCanvasElement) {
      // The installed content-safety.css caps Canvas inline size at its parent's
      // width. jsdom has no layout engine, so reproduce that observed constraint.
      const paintedWidth = parseFloat(this.style.width);
      const displayedWidth = contentSafety ? Math.min(paintedWidth, parseFloat(this.parentElement?.style.width || "") || width) : paintedWidth;
      return { x: 0, y: 0, left: 0, top: 0, right: displayedWidth, bottom: parseFloat(this.style.height), width: displayedWidth, height: parseFloat(this.style.height), toJSON: () => ({}) };
    });
    let path: Array<[number, number]> = [];
    const gradient = { addColorStop: vi.fn() };
    const ctx = { font: "", fillStyle: "", textAlign: "center",
      setTransform: vi.fn(), clearRect: () => { texts = []; cards = []; bodies = []; },
      beginPath: () => { path = []; }, moveTo: (x: number, y: number) => path.push([x, y]),
      arcTo: (x: number, y: number, x2: number, y2: number) => { path.push([x, y], [x2, y2]); },
      lineTo: vi.fn(), closePath: vi.fn(), stroke: vi.fn(), arc: vi.fn(),
      ellipse: (x: number, y: number) => { if (ctx.fillStyle === "rgba(0,0,0,.3)") bodies.push({ x, y: y - 2 }); },
      strokeRect: vi.fn(), fillRect: vi.fn(),
      fill: () => {
        if (typeof ctx.fillStyle === "string" && ctx.fillStyle.startsWith("rgba(255,255,255") && path.length) {
          const xs = path.map(point => point[0]), ys = path.map(point => point[1]);
          cards.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
        }
      },
      createLinearGradient: () => gradient, createRadialGradient: () => gradient,
      measureText: (text: string) => ({ width: Array.from(text).length * 9.5 }),
      fillText: (text: string, x: number, y: number) => texts.push({ text, x, y, font: ctx.font }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => unavailable ? null : ctx as unknown as CanvasRenderingContext2D);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    expect(frames.size).toBe(0);
    host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it("第一帧保留18个角色，待命名牌悬停显示；每个角色和完整牌都打开自己档案", async () => {
    const list = team(); await render(list); await advance();
    expect(cards).toHaveLength(0); expect(bodies).toHaveLength(18);
    for (const expected of list) {
      const slot = slotsOf(list).get(expected.id)!;
      expect(bodies.some(body => Math.abs(body.x - slot.sx) < 1 && Math.abs(body.y - slot.sy) < 1)).toBe(true);
      await click(slot.sx, slot.sy - 20);
      expect(profile.mock.calls.at(-1)![0].id).toBe(expected.id);
      await hover(slot.sx, slot.sy - 20);
      expect(cards).toHaveLength(1);
      expect(texts.some(text => text.text === expected.name)).toBe(true);
      await click(slot.card.x + 1, slot.card.y + slot.card.height - 1);
      expect(profile.mock.calls.at(-1)![0].id).toBe(expected.id);
    }
    expect(profile).toHaveBeenCalledTimes(36); expect(task).not.toHaveBeenCalled();
  });
  it("任务牌左右边缘和四个内角都打开任务；空白不触发；完整标题可悬停查看", async () => {
    const list = team(1, "working"); await render(list); await advance();
    const card = cards[0]!;
    for (const [x, y] of [[card.x + 1, card.y + 1], [card.x + card.width - 1, card.y + 1], [card.x + 1, card.y + card.height - 1], [card.x + card.width - 1, card.y + card.height - 1]]) await click(x!, y!);
    expect(task.mock.calls).toEqual([["job-0"], ["job-0"], ["job-0"], ["job-0"]]); expect(profile).not.toHaveBeenCalled();
    await click(1, 1); expect(task).toHaveBeenCalledTimes(4);
    await act(async () => canvas().dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: card.x + 1, clientY: card.y + 1 })));
    expect(canvas().title).toContain(list[0]!.currentThread!.title);
  });
  it("轮询换序、排队状态、尺寸变化与停用离场都重新使用有效绘制事实", async () => {
    const list = team(18, "queued"); await render(list); await advance();
    expect(bodies).toHaveLength(18);
    expect(texts.filter(item => item.text.startsWith("排队中 · "))).toHaveLength(2);
    const positions = texts.filter(item => list.some(agent => agent.name === item.text));
    await render([...list].reverse()); await advance(.5);
    expect(texts.filter(item => list.some(agent => agent.name === item.text))).toEqual(positions);
    width = 390; await advance(.5);
    expect(cards).toHaveLength(2); expect(bodies).toHaveLength(18); expect(parseFloat(canvas().style.width)).toBeGreaterThan(390);
    expect(host.querySelector('[role="region"]')?.getAttribute("tabindex")).toBe("0");
    await render(list.map(agent => ({ ...agent, state: "disabled" }))); await advance();
    expect(cards).toHaveLength(0); expect(canvas().getAttribute("data-product-scene-actors")).toBe("0");
    await click(positions[0]!.x, positions[0]!.y); expect(profile).not.toHaveBeenCalled(); expect(task).not.toHaveBeenCalled();
  });
  it("浏览器无法创建 Canvas 时显示明确错误", async () => {
    unavailable = true; await render(team(1));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("职场画布暂时无法显示");
  });
  it("内容安全样式下，窄屏看到的员工与名牌位置仍准确打开各自档案", async () => {
    width = 390; contentSafety = true;
    const list = team(); await render(list); await advance();
    const ratio = canvas().getBoundingClientRect().width / parseFloat(canvas().style.width);
    expect(bodies).toHaveLength(18); expect(cards).toHaveLength(0);
    for (const expected of list) {
      const slot = slotsOf(list).get(expected.id)!;
      const before = profile.mock.calls.length;
      await click(slot.sx * ratio, slot.sy - 20);
      expect(profile.mock.calls.length).toBe(before + 1);
      expect(profile.mock.calls.at(-1)![0].id).toBe(expected.id);
      await hover(slot.sx * ratio, slot.sy - 20);
      expect(cards).toHaveLength(1);
      await click((slot.card.x + 1) * ratio, slot.card.y + slot.card.height - 1);
      expect(profile.mock.calls.length).toBe(before + 2);
      expect(profile.mock.calls.at(-1)![0].id).toBe(expected.id);
    }
    expect(task).not.toHaveBeenCalled();
    // Text must remain legible at its measured size, rather than only remapping
    // clicks onto a visually compressed crowd.
    expect(ratio).toBe(1);
  });
  it("65 人长岗位场景首帧即能看到员工，用户滚动后轮询不会抢回位置", async () => {
    width = 390;
    const list = team(65).map((agent, index) => ({ ...agent, name: `跨区域客户生命周期增长策略与特殊需求研究负责人${index}`.repeat(3) }));
    await render(list); await advance();
    const region = host.querySelector<HTMLElement>('[role="region"]')!;
    const visible = () => bodies.filter(body => body.x >= region.scrollLeft && body.x <= region.scrollLeft + width && body.y >= region.scrollTop && body.y <= region.scrollTop + 440);
    expect(visible().length).toBeGreaterThan(0);
    region.scrollLeft = 17; region.scrollTop = 19;
    await act(async () => region.dispatchEvent(new Event("scroll", { bubbles: true })));
    await render([...list].reverse()); await advance();
    expect(region.scrollLeft).toBe(17); expect(region.scrollTop).toBe(19);
    width = 768; await advance();
    expect(region.scrollLeft).toBe(17); expect(region.scrollTop).toBe(19);
  });
});
