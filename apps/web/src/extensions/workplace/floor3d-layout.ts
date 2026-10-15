import type { FloorAgent, FloorScene } from "../../pages/p0/Floor";
import { floorRectsOverlap, type FloorRect } from "../../pages/p0/floor-layout";
import * as THREE from "three";

export interface FloorLabelAnchor { id: string; x: number; y: number; width: number; height: number }

/** One global cell per actor, including workers without a station; polling order does not matter. */
export function floor3DTargets(agents: FloorAgent[], scene: FloorScene): Map<string, { x: number; y: number }> {
  const active = agents.filter(agent => agent.state !== "disabled").sort((a, b) => a.id.localeCompare(b.id));
  const targets = new Map<string, { x: number; y: number }>();
  if (!active.length) return targets;
  const columns = Math.max(1, Math.ceil(Math.sqrt((active.length + 2) * scene.grid.w / scene.grid.h)));
  const rows = Math.ceil((active.length + 2) / columns);
  const candidates = Array.from({ length: columns * rows }, (_, index) => ({
    x: (index % columns + .5) * scene.grid.w / columns,
    y: (Math.floor(index / columns) + .5) * scene.grid.h / rows,
  }));
  // Keep the closest cell for the CEO; the remaining pool still has room for every employee.
  const ceo = candidates.reduce((best, point) => (point.x - scene.ceoDesk.x) ** 2 + (point.y - scene.ceoDesk.y) ** 2 < (best.x - scene.ceoDesk.x) ** 2 + (best.y - scene.ceoDesk.y) ** 2 ? point : best);
  candidates.splice(candidates.indexOf(ceo), 1);
  for (const agent of active) {
    const station = scene.stations.find(item => item.id === agent.stationId);
    const preferred = agent.state === "asking" ? { x: scene.ceoDesk.x, y: scene.ceoDesk.y + 1.1 }
      : station ? { x: station.x, y: station.y + .4 }
        : agent.state === "blocked" ? { x: scene.grid.w / 2, y: scene.grid.h / 2 } : scene.lounge;
    let closest = 0;
    for (let index = 1; index < candidates.length; index++) {
      const point = candidates[index]!, best = candidates[closest]!;
      if ((point.x - preferred.x) ** 2 + (point.y - preferred.y) ** 2 < (best.x - preferred.x) ** 2 + (best.y - preferred.y) ** 2) closest = index;
    }
    targets.set(agent.id, candidates.splice(closest, 1)[0]!);
  }
  return targets;
}

/** Fit the default landing camera to the actual body bounds, including dense rosters. */
export function floor3DCameraHeight(targets: Map<string, { x: number; y: number }>, scene: FloorScene, tile: number): number {
  let height = Math.max(scene.grid.w, scene.grid.h) * tile * .95;
  const camera = new THREE.PerspectiveCamera(40, 1, .1, 1000);
  const point = new THREE.Vector3();
  for (let attempt = 0; attempt < 20; attempt++) {
    camera.position.set(height * .76, height * .88, height * .76);
    camera.lookAt(0, .3, 0); camera.updateMatrixWorld();
    const fits = [...targets.values()].every(target => {
      const x = (target.x - scene.grid.w / 2) * tile, z = (target.y - scene.grid.h / 2) * tile;
      for (const dx of [-.4, .4]) for (const y of [.2, 1.15]) for (const dz of [-.4, .4]) {
        point.set(x + dx, y, z + dz).project(camera);
        if (Math.abs(point.x) > .9 || Math.abs(point.y) > .9 || point.z < -1 || point.z > 1) return false;
      }
      return true;
    });
    if (fits) return height;
    height *= 1.12;
  }
  throw new RangeError("Floor bodies exceed the default camera view");
}

/** Screen-space names keep their actual CSS size through camera movement and zoom. */
export function placeFloor3DLabels(labels: FloorLabelAnchor[], width: number, height: number, reserved: FloorRect[] = []): Map<string, FloorRect> | null {
  const placed = new Map<string, FloorRect>();
  const occupied = [...reserved];
  const sorted = [...labels].sort((a, b) => b.width * b.height - a.width * a.height || a.id.localeCompare(b.id));
  for (const label of sorted) {
    let best: FloorRect | null = null;
    let nearest = Infinity;
    const left = label.x - label.width / 2, top = label.y - label.height / 2;
    const inspect = (x: number, y: number) => {
      const distance = (x - left) ** 2 + (y - top) ** 2;
      if (distance >= nearest || x < 6 || y < 6 || x + label.width > width - 6 || y + label.height > height - 6) return;
      const rect = { x, y, width: label.width, height: label.height };
      const padded = { x: x - 3, y: y - 3, width: label.width + 6, height: label.height + 6 };
      if (occupied.some(item => floorRectsOverlap(padded, item))) return;
      best = rect; nearest = distance;
    };
    inspect(Math.max(6, Math.min(width - label.width - 6, left)), Math.max(6, Math.min(height - label.height - 6, top)));
    if (nearest !== 0) for (let y = 6; y <= height - label.height - 6; y += 8) for (let x = 6; x <= width - label.width - 6; x += 8) inspect(x, y);
    if (!best) return null;
    const rect: FloorRect = best;
    occupied.push({ x: rect.x - 3, y: rect.y - 3, width: rect.width + 6, height: rect.height + 6 });
    placed.set(label.id, rect);
  }
  return placed;
}
