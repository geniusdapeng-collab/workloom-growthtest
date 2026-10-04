/**
 * HoverBubble · 一句话状态条（hover 0.5s / 注视触发共用）
 *
 * 深色胶囊：角色当前状态一句话（statusLine，真实任务数据）。
 * 与名牌分层：名牌恒定显示人名，气泡显示"在做什么"。
 */
import { Html } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

export function HoverBubble({
  text, visible, position = [0, 1.05, 0],
}: {
  text: string;
  visible: boolean;
  position?: [number, number, number];
}) {
  const { gl } = useThree();
  const node = useRef<HTMLDivElement>(null);
  const projected = useRef(new THREE.Vector3());
  const calculatePosition = useMemo(() => (object: THREE.Object3D, camera: THREE.Camera, size: { width: number; height: number }): [number, number] => {
    projected.current.setFromMatrixPosition(object.matrixWorld).project(camera);
    const x = (projected.current.x + 1) * size.width / 2, y = (1 - projected.current.y) * size.height / 2;
    if (!node.current) return [x, y];
    const canvas = gl.domElement, rect = canvas.getBoundingClientRect();
    const region = canvas.closest<HTMLElement>("[data-product-scene]") ?? canvas.parentElement;
    const bounds = region?.getBoundingClientRect() ?? rect;
    // A centered Html bubble must fit the currently visible scroll viewport,
    // rather than only the potentially much larger Canvas backing area.
    const left = Math.max(0, rect.left, bounds.left + (region?.clientLeft ?? 0)) + 8 - rect.left;
    const top = Math.max(0, rect.top, bounds.top + (region?.clientTop ?? 0)) + 8 - rect.top;
    const right = Math.min(window.innerWidth, rect.right, bounds.left + (region?.clientLeft ?? 0) + (region?.clientWidth ?? rect.width)) - 8 - rect.left;
    const bottom = Math.min(window.innerHeight, rect.bottom, bounds.top + (region?.clientTop ?? 0) + (region?.clientHeight ?? rect.height)) - 8 - rect.top;
    if (right <= left || bottom <= top) return [x, y];
    const maxWidth = `${Math.min(260, right - left)}px`;
    if (node.current.style.maxWidth !== maxWidth) node.current.style.maxWidth = maxWidth;
    const halfWidth = node.current.offsetWidth / 2, halfHeight = node.current.offsetHeight / 2;
    const clamp = (value: number, minimum: number, maximum: number) => minimum > maximum ? (minimum + maximum) / 2 : Math.max(minimum, Math.min(maximum, value));
    node.current.style.visibility = "visible";
    return [clamp(x, left + halfWidth, right - halfWidth), clamp(y, top + halfHeight, bottom - halfHeight)];
  }, [gl]);
  if (!visible || !text) return null;
  return (
    <Html ref={node} center position={position} calculatePosition={calculatePosition} wrapperClass="wl-hover-bubble-projection"
      style={{ pointerEvents: "none", visibility: "hidden", width: "max-content", maxWidth: "min(260px, calc(100vw - 32px))", transitionProperty: "none" }} zIndexRange={[30, 0]}>
      <div style={{
        maxWidth: 260, overflowWrap: "anywhere",
        fontSize: 14, color: "#eef4ff", lineHeight: 1.5,
        background: "rgba(14,16,19,.88)", border: "1px solid rgba(179,198,222,.35)",
        borderRadius: 8, padding: "3px 10px",
        boxShadow: "0 4px 16px rgba(0,0,0,.4)",
        animation: "wl-bubble-in .18s ease-out",
      }}>
        {text}
      </div>
      <style>{`.wl-hover-bubble-projection { transition-property: none; } @keyframes wl-bubble-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </Html>
  );
}
