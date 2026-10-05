// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { FloorAgent } from "../pages/p0/Floor";
import { createFloor3DLabelRegistry } from "./Floor3DLabels";
import { Floor3DTaskDrop } from "./Floor3DTaskDrop";

const state = vi.hoisted(() => ({ value: {} as any }));
vi.mock("@react-three/fiber", () => ({ useThree: () => state.value }));

describe("职场原生任务拖放", () => {
  let root: Root, host: HTMLDivElement, canvas: HTMLCanvasElement;
  let camera: THREE.OrthographicCamera;
  let rect: { left: number; top: number; width: number; height: number };
  let registry: ReturnType<typeof createFloor3DLabelRegistry>;
  let list: FloorAgent[];
  const callback = vi.fn();
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    canvas = document.createElement("canvas"); host.appendChild(canvas);
    camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 100);
    camera.position.z = 10; camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    rect = { left: 113, top: 71, width: 768, height: 440 };
    vi.spyOn(canvas, "getBoundingClientRect").mockImplementation(() => ({ ...rect, x: rect.left, y: rect.top,
      right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => ({}) }));
    registry = createFloor3DLabelRegistry();
    list = ["left", "right"].map((id, index) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(.4, 8, 8), new THREE.MeshBasicMaterial());
      mesh.position.set(index ? .8 : -.8, .7, 0); mesh.visible = false;
      registry.hitAreas.set(id, mesh);
      return { id, presetKey: id, name: "客户成功专员", state: "idle", stationId: null, currentThread: null,
        pendingTier: null, approvalId: null, statusLine: "本地拖放回归" } as FloorAgent;
    });
    state.value = { camera, gl: { domElement: canvas } }; callback.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    for (const mesh of registry.hitAreas.values()) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    host.remove(); vi.restoreAllMocks();
  });
  const render = async () => act(async () => root.render(<Floor3DTaskDrop registry={registry} agents={list} onDropTask={callback} />));
  function transfer(payload = "任务内容😀", types = ["text/workloom-task"]) {
    return { types, dropEffect: "none", getData: vi.fn(() => payload) };
  }
  function event(kind: string, x: number, y: number, data = transfer()) {
    const drag = new MouseEvent(kind, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(drag, "dataTransfer", { value: data }); canvas.dispatchEvent(drag);
    return drag;
  }
  function body(id: string) {
    const mesh = registry.hitAreas.get(id)!; mesh.updateMatrixWorld();
    const point = mesh.position.clone().add(new THREE.Vector3(0, .15, 0)).project(camera);
    return [rect.left + (point.x + 1) / 2 * rect.width, rect.top + (1 - point.y) / 2 * rect.height] as const;
  }
  it("每个真实 Three 身体球体仅分派给自己，CSS 尺寸和滚动变化后仍正确", async () => {
    await render();
    for (const id of ["left", "right"]) {
      const data = transfer();
      expect(event("dragover", ...body(id), data).defaultPrevented).toBe(true); expect(data.dropEffect).toBe("copy");
      event("drop", ...body(id), data);
    }
    expect(callback.mock.calls.map(([agent, task]) => [agent.id, task])).toEqual([["left", "任务内容😀"], ["right", "任务内容😀"]]);
    rect = { left: -238, top: -97, width: 1024, height: 593 };
    event("drop", ...body("right"), transfer("需要复核的客户特殊素材"));
    expect(callback.mock.calls.at(-1)).toEqual([list[1], "需要复核的客户特殊素材"]);
  });
  it("重合射线只分派最靠近相机的球体；轮询使用当前员工数据，停用后不分派", async () => {
    registry.hitAreas.get("right")!.position.set(-.8, .7, 1);
    await render(); event("drop", ...body("left"));
    expect(callback.mock.calls.at(-1)![0].id).toBe("right");
    list = [...list].reverse().map(agent => ({ ...agent, name: "轮询更新后的客户负责人" }));
    await render(); event("drop", ...body("left"));
    expect(callback.mock.calls.at(-1)![0]).toBe(list[0]);
    list = list.map(agent => ({ ...agent, state: "disabled" }));
    await render(); event("drop", ...body("left"));
    expect(callback).toHaveBeenCalledTimes(2);
  });
  it("空白、错误类型、空内容、数据读取失败和卸载均不触发错误分派", async () => {
    await render();
    event("drop", rect.left + 1, rect.top + 1);
    const wrong = transfer("不应被接受", ["text/plain"]); event("drop", ...body("left"), wrong);
    expect(wrong.getData).not.toHaveBeenCalled();
    event("drop", ...body("left"), transfer("  "));
    const unavailable = transfer(); unavailable.getData.mockImplementation(() => { throw new DOMException("Unavailable", "SecurityError"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    event("drop", ...body("left"), unavailable); expect(error).toHaveBeenCalledOnce();
    await act(async () => root.render(null)); event("drop", ...body("left"));
    expect(callback).not.toHaveBeenCalled();
  });
});
