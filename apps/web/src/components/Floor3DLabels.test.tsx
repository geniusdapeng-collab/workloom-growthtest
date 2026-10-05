// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { floorRectsOverlap } from "../pages/p0/floor-layout";
import { createFloor3DLabelRegistry, Floor3DLabels } from "./Floor3DLabels";

const frame = vi.hoisted(() => ({ callback: null as null | ((state: any) => void) }));
vi.mock("@react-three/fiber", () => ({ useFrame: (callback: (state: any) => void) => { frame.callback = callback; } }));

describe("3D 名牌的真实分配组件", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fixtures: HTMLElement[];
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    fixtures = [];
    frame.callback = null;
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); fixtures.forEach(node => node.remove()); });

  it.each(["connected-portal", "canvas-parent"])("在 %s 容器的公司负责人固定牌旁分配员工名牌", async placement => {
    const registry = createFloor3DLabelRegistry();
    const actor = new THREE.Group(); actor.position.y = -1.55;
    registry.actors.set("worker", actor);
    const label = document.createElement("div");
    Object.defineProperties(label, { offsetWidth: { value: 100 }, offsetHeight: { value: 40 } });
    registry.nodes.set("worker", label);
    const scene = document.createElement("div"); scene.dataset.productScene = "workplace-3d";
    const connected = document.createElement("div"), measure = document.createElement("div"), canvas = document.createElement("canvas");
    measure.appendChild(canvas); connected.appendChild(measure); scene.appendChild(connected);
    const plaque = document.createElement("div"); plaque.dataset.productNameplate = "";
    (placement === "connected-portal" ? connected : measure).appendChild(plaque);
    const bounds = { x: 270, y: 200, width: 100, height: 40 };
    canvas.getBoundingClientRect = () => ({ x: 100, y: 50, left: 100, top: 50, right: 740, bottom: 490, width: 640, height: 440, toJSON: () => ({}) });
    plaque.getBoundingClientRect = () => ({ x: 370, y: 250, left: 370, top: 250, right: 470, bottom: 290, width: 100, height: 40, toJSON: () => ({}) });
    document.body.appendChild(scene); fixtures.push(scene);
    const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 100);
    camera.position.z = 10; camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    await act(async () => root.render(<Floor3DLabels registry={registry} />));
    frame.callback!({ camera, size: { width: 640, height: 440 }, gl: { domElement: canvas } });
    const [x, y] = registry.positions.get("worker")!;
    expect(floorRectsOverlap({ x: x - 50, y: y - 20, width: 100, height: 40 }, bounds)).toBe(false);
    expect(label.style.visibility).toBe("visible");
  });

  it("名字单独能放下但人物预留空间不足时仍扩容，后续帧持续重试，扩容后保留身体命中空间", async () => {
    const registry = createFloor3DLabelRegistry();
    registry.grow = vi.fn();
    const actor = new THREE.Group(); actor.scale.setScalar(3);
    registry.actors.set("worker", actor);
    const node = document.createElement("div");
    Object.defineProperties(node, { offsetWidth: { value: 600 }, offsetHeight: { value: 400 } });
    registry.nodes.set("worker", node);
    const canvas = document.createElement("canvas"); host.appendChild(canvas);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 100);
    camera.position.z = 10; camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    await act(async () => root.render(<Floor3DLabels registry={registry} />));
    const advance = (width: number, height: number) => frame.callback!({ camera, size: { width, height }, gl: { domElement: canvas } });
    advance(640, 440);
    expect(registry.grow).toHaveBeenCalledTimes(1);
    advance(640, 440);
    expect(registry.grow).toHaveBeenCalledTimes(2);
    advance(1280, 880);
    expect(registry.grow).toHaveBeenCalledTimes(2);
    const [x, y] = registry.positions.get("worker")!;
    const rect = { x: x - 300, y: y - 200, width: 600, height: 400 };
    expect(floorRectsOverlap(rect, { x: -130, y: -1080, width: 1540, height: 1260 })).toBe(false);
    expect(node.style.visibility).toBe("visible");
  });
});
