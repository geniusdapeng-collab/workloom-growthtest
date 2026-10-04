import { describe, expect, it } from "vitest";
import * as THREE from "three";
import scene from "../../../../bundles/geo-growth/floor-scene.json";
import type { FloorAgent } from "../pages/p0/Floor";
import { floorRectsOverlap } from "../pages/p0/floor-layout";
import { floor3DCameraHeight, floor3DTargets, placeFloor3DLabels } from "./floor3d-layout";

const agents = (state: FloorAgent["state"], stationId: string | null = null) => Array.from({ length: 18 }, (_, index) => ({
  id: `actor-${index}`, presetKey: `role-${index}`, name: "客户增长专员", state, stationId,
  currentThread: null, pendingTier: null, approvalId: null, statusLine: "本地空间回归",
}));

describe("3D 职场占位与名牌分配", () => {
  it.each(["idle", "asking", "blocked", "working", "celebrating", "collab", "queued"] as const)("%s 的空工位与共享工位 18 人都取得独立且有间隔的坐标", state => {
    for (const stationId of [null, scene.stations[0]!.id]) {
      const list = agents(state, stationId);
      const targets = floor3DTargets(list, scene);
      expect(targets.size).toBe(18);
      expect(new Set([...targets.values()].map(point => `${point.x}/${point.y}`)).size).toBe(18);
      expect([...floor3DTargets([...list].reverse(), scene)]).toEqual([...targets]);
      const points = [...targets.values()];
      for (let first = 0; first < points.length; first++) for (let second = first + 1; second < points.length; second++) {
        const a = points[first]!, b = points[second]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(1.5);
      }
    }
  });
  it("停用和空团队不留下可点演员", () => {
    expect(floor3DTargets(agents("disabled"), scene).size).toBe(0);
    expect(floor3DTargets([], scene).size).toBe(0);
    expect(placeFloor3DLabels([], 640, 440)?.size).toBe(0);
  });
  it("65 人最靠近镜头的员工在默认落点相机内，头像点击位置可以通过滚动触达", () => {
    const sample = agents("idle")[0]!;
    const list = Array.from({ length: 65 }, (_, index) => ({ ...sample, id: `actor-${String(index).padStart(2, "0")}` }));
    const targets = floor3DTargets(list, scene), tile = 1.02;
    const camera = new THREE.PerspectiveCamera(40, 1, .1, 1000);
    const observe = (height: number) => {
      camera.position.set(height * .76, height * .88, height * .76); camera.lookAt(0, .3, 0); camera.updateMatrixWorld();
      return [...targets.values()].map(target => new THREE.Vector3((target.x - scene.grid.w / 2) * tile, .85, (target.y - scene.grid.h / 2) * tile).project(camera));
    };
    expect(observe(Math.max(scene.grid.w, scene.grid.h) * tile * .95).some(point => Math.abs(point.y) > 1)).toBe(true);
    const fitted = observe(floor3DCameraHeight(targets, scene, tile));
    expect(fitted).toHaveLength(65);
    expect(fitted.every(point => Math.abs(point.x) <= .9 && Math.abs(point.y) <= .9 && point.z >= -1 && point.z <= 1)).toBe(true);
  });
  it("18 个重合的投影点仍分配分离名牌，并给实际人物保留点击空间", () => {
    const labels = agents("idle").map((agent, index) => ({ id: agent.id, x: 320, y: 210, width: 80 + index % 4 * 9, height: 34 }));
    const body = { x: 280, y: 215, width: 80, height: 80 };
    const positions = placeFloor3DLabels(labels, 640, 440, [body])!;
    expect(positions.size).toBe(18);
    const rects = [...positions.values()];
    for (const rect of rects) expect(floorRectsOverlap(rect, body)).toBe(false);
    for (let first = 0; first < rects.length; first++) for (let second = first + 1; second < rects.length; second++) expect(floorRectsOverlap(rects[first]!, rects[second]!)).toBe(false);
    expect([...placeFloor3DLabels([...labels].reverse(), 640, 440, [body])!]).toEqual([...positions]);
  });
  it("视野外锚点仍有可见名牌，超出画布的文字明确报告需要扩容", () => {
    const result = placeFloor3DLabels([{ id: "outside", x: -100, y: 900, width: 140, height: 90 }], 640, 440)!;
    expect(result.get("outside")!.x).toBeGreaterThanOrEqual(0);
    expect(result.get("outside")!.y + 90).toBeLessThanOrEqual(440);
    expect(placeFloor3DLabels([{ id: "huge", x: 100, y: 100, width: 800, height: 90 }], 640, 440)).toBeNull();
  });
});
