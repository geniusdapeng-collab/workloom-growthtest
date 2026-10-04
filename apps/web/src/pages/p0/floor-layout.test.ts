import { describe, expect, it } from "vitest";
import scene from "../../../../../bundles/geo-growth/floor-scene.json";
import type { FloorAgent, FloorPayload } from "./Floor";
import { createFloorLayout, floorRectsOverlap } from "./floor-layout";

function context(): CanvasRenderingContext2D {
  return { font: "", textAlign: "center", measureText: (text: string) => {
    const width = Array.from(text).length * 9.5;
    return { width, actualBoundingBoxLeft: width / 2 + 1, actualBoundingBoxRight: width / 2 + 2 };
  } } as unknown as CanvasRenderingContext2D;
}
function agents(count: number, state: FloorAgent["state"] = "idle", stationId: string | null = null): FloorAgent[] {
  return Array.from({ length: count }, (_, index) => ({ id: `layout-${index}`, presetKey: `role-${index}`, name: `客户增长分析官${"甲乙丙丁"[index % 4]}`,
    state, stationId, currentThread: state === "working" || state === "queued" ? { id: `task-${index}`, title: "需要复核的客户素材与发布记录" } : null,
    pendingTier: null, approvalId: null, statusLine: "本地布局回归" }));
}
function assertUsable(floor: FloorPayload, width: number, height: number) {
  const layout = createFloorLayout(floor, width, height, context());
  const slots = [...layout.slots.values()];
  expect(slots).toHaveLength(floor.agents.filter(agent => agent.state !== "disabled").length);
  for (const slot of slots) {
    expect(slot.card.x).toBeGreaterThanOrEqual(0); expect(slot.card.y).toBeGreaterThanOrEqual(0);
    expect(slot.card.x + slot.card.width).toBeLessThanOrEqual(layout.width);
    expect(slot.card.y + slot.card.height).toBeLessThanOrEqual(layout.height);
    expect(slot.x).toBeGreaterThan(0); expect(slot.x).toBeLessThan(scene.grid.w);
    expect(slot.y).toBeGreaterThan(0); expect(slot.y).toBeLessThan(scene.grid.h);
  }
  for (let first = 0; first < slots.length; first++) for (let second = first + 1; second < slots.length; second++) {
    expect(floorRectsOverlap(slots[first]!.bounds, slots[second]!.bounds), `${slots[first]!.id}/${slots[second]!.id}`).toBe(false);
  }
  return layout;
}

describe("职场名牌实际测量与分配", () => {
  it.each(["idle", "working", "asking", "blocked", "celebrating", "collab", "queued"] as const)("18 名 %s 员工共享工位或没有工位时仍互不遮挡", state => {
    for (const stationId of [null, scene.stations[0]!.id]) assertUsable({ scene, agents: agents(18, state, stationId) }, 768, 440);
  });
  it("窄屏为 65 人及长岗位名保留每个人与完整文字，内容在自有画布内展开", () => {
    const list = agents(65);
    list[0]!.name = "跨区域客户生命周期增长策略与特殊需求研究负责人".repeat(3);
    const layout = assertUsable({ scene, agents: list }, 390, 380);
    expect(layout.slots.get(list[0]!.id)!.roleLines.join("")).toBe(list[0]!.name);
    expect(layout.slots.get(list[0]!.id)!.roleLines.length).toBeGreaterThan(1);
    expect(layout.width).toBeGreaterThan(390);
  });
  it("同一批数据换序不改变岗位位置，避免轮询引发无意义的站位变化", () => {
    const list = agents(18, "working");
    const first = createFloorLayout({ scene, agents: list }, 768, 440, context());
    const second = createFloorLayout({ scene, agents: [...list].reverse() }, 768, 440, context());
    expect([...second.slots]).toEqual([...first.slots]);
  });
  it("空团队和停用团队不产生虚假演员；排队任务正确显示状态", () => {
    expect(assertUsable({ scene, agents: [] }, 390, 380).slots.size).toBe(0);
    expect(assertUsable({ scene, agents: agents(18, "disabled") }, 390, 380).slots.size).toBe(0);
    const list = agents(1, "queued");
    expect(assertUsable({ scene, agents: list }, 768, 440).slots.get(list[0]!.id)!.stateLines.join("")).toMatch(/^排队中 · /);
  });
  it("不可用的场景和视口尺寸明确失败，不能陷入无界分配", () => {
    for (const invalid of [0, -1, NaN, Infinity]) {
      expect(() => createFloorLayout({ scene: { ...scene, grid: { ...scene.grid, w: invalid } }, agents: agents(1) }, 768, 440, context())).toThrow(RangeError);
      expect(() => createFloorLayout({ scene, agents: agents(1) }, invalid, 440, context())).toThrow(RangeError);
    }
  });
});
