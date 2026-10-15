import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { floorRectsOverlap, type FloorRect } from "../../pages/p0/floor-layout";
import { placeFloor3DLabels, type FloorLabelAnchor } from "./floor3d-layout";

export interface Floor3DLabelRegistry {
  actors: Map<string, THREE.Group>;
  hitAreas: Map<string, THREE.Mesh>;
  nodes: Map<string, HTMLDivElement>;
  lines: Map<string, SVGLineElement>;
  positions: Map<string, [number, number]>;
  measure?: (node?: HTMLDivElement) => void;
  grow?: () => void;
  focus?: (rects: Map<string, FloorRect>, width: number, height: number) => void;
}

export function createFloor3DLabelRegistry(): Floor3DLabelRegistry {
  return { actors: new Map(), hitAreas: new Map(), nodes: new Map(), lines: new Map(), positions: new Map() };
}

/** Negative priority runs after actor/OrbitControls updates and before Drei's Html projection. */
export function Floor3DLabels({ registry }: { registry: Floor3DLabelRegistry }) {
  const point = useRef(new THREE.Vector3());
  const cache = useRef<{ signature: string; anchors: FloorLabelAnchor[]; rects: Map<string, FloorRect>; avoidsBodies: boolean } | null>(null);
  useFrame(({ camera, size, gl }) => {
    camera.updateMatrixWorld();
    const labels: FloorLabelAnchor[] = [];
    const bodies: FloorRect[] = [];
    const fixedPlaques: FloorRect[] = [];
    const heads = new Map<string, { x: number; y: number }>();
    const project = (group: THREE.Group, x: number, y: number, z: number) => {
      point.current.set(x, y, z).applyMatrix4(group.matrixWorld).project(camera);
      return { x: (point.current.x + 1) * size.width / 2, y: (1 - point.current.y) * size.height / 2 };
    };
    for (const [id, group] of registry.actors) {
      const node = registry.nodes.get(id);
      if (!node || !node.offsetWidth || !node.offsetHeight) continue;
      group.updateWorldMatrix(true, false);
      const anchor = project(group, 0, 1.55, 0);
      labels.push({ id, ...anchor, width: node.offsetWidth, height: node.offsetHeight });
      heads.set(id, project(group, 0, .95, 0));
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const x of [-.4, .4]) for (const y of [.2, 1.15]) for (const z of [-.4, .4]) {
        const corner = project(group, x, y, z);
        left = Math.min(left, corner.x); top = Math.min(top, corner.y);
        right = Math.max(right, corner.x); bottom = Math.max(bottom, corner.y);
      }
      bodies.push({ x: left - 2, y: top - 2, width: right - left + 4, height: bottom - top + 4 });
    }
    // The CEO's separate HTML plaque also participates in collision avoidance.
    // Drei Html uses Fiber's connected event container, outside the canvas measurement div.
    const scene = gl.domElement.closest('[data-product-scene="workplace-3d"]') ?? gl.domElement.parentElement;
    const ceo = scene?.querySelector<HTMLElement>("[data-product-nameplate]:not([data-worker-id])");
    if (ceo) {
      const canvas = gl.domElement.getBoundingClientRect(), rect = ceo.getBoundingClientRect();
      fixedPlaques.push({ x: rect.left - canvas.left, y: rect.top - canvas.top, width: rect.width, height: rect.height });
    }
    const signature = JSON.stringify([size.width, size.height, labels.map(label => [label.id, label.width, label.height]).sort()]);
    const prior = cache.current;
    const changed = !prior || signature !== prior.signature || labels.some(label => {
      const anchor = prior.anchors.find(item => item.id === label.id);
      return !anchor || Math.hypot(anchor.x - label.x, anchor.y - label.y) > 8;
    }) || [...(prior?.rects.values() ?? [])].some(rect => fixedPlaques.some(plaque => floorRectsOverlap(rect, plaque)))
      || (prior.avoidsBodies && [...prior.rects.values()].some(rect => bodies.some(body => floorRectsOverlap(rect, body))));
    if (changed) {
      const strict = placeFloor3DLabels(labels, size.width, size.height, [...bodies, ...fixedPlaques]);
      // Keep names readable while the scrollable viewport grows. A body-obstructing
      // fallback is temporary; it must never count as a completed allocation.
      const rects = strict ?? placeFloor3DLabels(labels, size.width, size.height, fixedPlaques);
      if (!rects) {
        for (const node of registry.nodes.values()) node.style.visibility = "hidden";
        registry.grow?.();
        return;
      }
      cache.current = { signature, anchors: labels, rects, avoidsBodies: strict !== null };
    }
    if (!cache.current!.avoidsBodies) registry.grow?.();
    const rects = cache.current!.rects;
    registry.focus?.(rects, size.width, size.height);
    registry.positions.clear();
    for (const [id, rect] of rects) {
      registry.positions.set(id, [rect.x + rect.width / 2, rect.y + rect.height / 2]);
      const node = registry.nodes.get(id);
      if (node) node.style.visibility = "visible";
      const line = registry.lines.get(id), head = heads.get(id);
      if (line && head) {
        const x = Math.max(rect.x, Math.min(rect.x + rect.width, head.x));
        const y = Math.max(rect.y, Math.min(rect.y + rect.height, head.y));
        line.setAttribute("x1", String(head.x)); line.setAttribute("y1", String(head.y));
        line.setAttribute("x2", String(x)); line.setAttribute("y2", String(y));
        line.style.opacity = node?.querySelector("[data-worker-card-visible=\"false\"]") ? "0" : Math.hypot(x - head.x, y - head.y) > 6 ? ".42" : "0";
      }
    }
  }, -.5);
  return null;
}
