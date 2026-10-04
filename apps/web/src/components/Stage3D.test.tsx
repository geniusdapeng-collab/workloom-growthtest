// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Stage3D } from "./Stage3D";

const lighting = vi.hoisted(() => ({ night: false }));
// Resolve the real Stage3D -> Theater -> CineFloor JSX without creating a GPU.
// Only renderer/material adapters are replaced; both surface positions and the
// cylinder geometry come from the product components. Native pixels are tested
// separately because this geometry guard alone cannot establish visual quality.
vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children: ReactNode }) => <>{children}</>,
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}));
vi.mock("@react-three/drei", () => ({
  OrbitControls: vi.fn(() => null),
  MeshReflectorMaterial: () => <div data-stage-reflector />,
  Sparkles: vi.fn(() => null),
  Html: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@react-three/postprocessing", () => ({
  EffectComposer: vi.fn(() => null),
  Bloom: vi.fn(() => null),
  Vignette: vi.fn(() => null),
  Noise: vi.fn(() => null),
}));
vi.mock("../lib/useNightTime", () => ({ useNightTime: () => lighting.night }));

function numbers(node: Element, attribute: string, count?: number): number[] {
  const value = node.getAttribute(attribute);
  if (!value) throw new Error(`Actual scene element is missing ${attribute}`);
  const result = value.split(",").slice(0, count).map(Number);
  if (count !== undefined && result.length !== count) throw new Error(`Incomplete scene ${attribute}: ${value}`);
  if (!result.every(Number.isFinite)) throw new Error(`Invalid scene ${attribute}: ${value}`);
  return result;
}

describe("汇报舞台反射面与实体底座的空间分离", () => {
  it.each([false, true])("night=%s 时底座顶面低于实际可见反射面", night => {
    lighting.night = night;
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<Stage3D agents={[]} onPick={vi.fn()} />);
    const reflectors = host.querySelectorAll("[data-stage-reflector]");
    expect(reflectors).toHaveLength(1);
    const floor = reflectors[0]!.closest("mesh")!;
    const floorY = numbers(floor, "position")[1]!;
    const bases = [...host.querySelectorAll("cylindergeometry")].filter(node => {
      const args = numbers(node, "args", 4);
      return args[0] === 5.4 && args[1] === 5.6;
    });
    expect(bases).toHaveLength(1);
    const base = bases[0]!;
    const [topRadius, bottomRadius, height, segments] = numbers(base, "args", 4);
    const geometry = new THREE.CylinderGeometry(topRadius, bottomRadius, height, segments);
    try {
      geometry.computeBoundingBox();
      const baseY = numbers(base.closest("mesh")!, "position")[1]!;
      const baseTop = baseY + geometry.boundingBox!.max.y;
      // At this scene scale a real gap prevents two opaque surfaces from
      // competing for the same depth, including the reflector's second pass.
      expect(floorY - baseTop).toBeGreaterThanOrEqual(0.005);
      expect(floor.querySelector("circlegeometry")).not.toBeNull();
      expect(floor.hasAttribute("visible")).toBe(false);
    } finally {
      geometry.dispose();
    }
  });
});
