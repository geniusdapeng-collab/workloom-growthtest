import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { FloorAgent } from "../../pages/p0/Floor";
import type { Floor3DLabelRegistry } from "./Floor3DLabels";

const TASK_TYPE = "text/workloom-task";

/** Native drops use the same Three hit spheres as body clicks, without HTML hotspots. */
export function Floor3DTaskDrop({ registry, agents, onDropTask }: {
  registry: Floor3DLabelRegistry;
  agents: FloorAgent[];
  onDropTask: (agent: FloorAgent, task: string) => void;
}) {
  const { camera, gl } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const hitAgent = (event: DragEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) return;
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
      camera.updateMatrixWorld();
      const areas = [...registry.hitAreas];
      for (const [, area] of areas) area.updateWorldMatrix(true, false);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(areas.map(([, area]) => area), false)[0];
      if (!hit) return;
      const id = areas.find(([, area]) => area === hit.object)?.[0];
      return agents.find(agent => agent.id === id && agent.state !== "disabled");
    };
    const accepts = (event: DragEvent) => event.dataTransfer && Array.from(event.dataTransfer.types).includes(TASK_TYPE);
    const over = (event: DragEvent) => {
      if (!accepts(event) || !hitAgent(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      const agent = hitAgent(event);
      if (!agent) return;
      let task: string;
      try { task = event.dataTransfer!.getData(TASK_TYPE); }
      catch (error) { console.error("Floor task drop unavailable", error); return; }
      if (task.trim()) onDropTask(agent, task);
    };
    canvas.addEventListener("dragover", over);
    canvas.addEventListener("drop", drop);
    return () => { canvas.removeEventListener("dragover", over); canvas.removeEventListener("drop", drop); };
  }, [camera, gl, registry, agents, onDropTask]);
  return null;
}
