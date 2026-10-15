/**
 * CeremonyStage · 仪式引擎（方案 V4 §0/§7b/§7d）
 * 通用产品机制：输入当前工作区团队编制 → 按 roleSkinOf 自动布阵 → KayKit 骨骼动画演绎。
 * 任何行业版零定制复用：酒店版出来酒店团队、电商版出来电商团队。
 *
 * 编舞机制：
 *  - 慢半拍担当：每场随机 1-2 名员工节奏慢 29%、相位晚半拍（不协调之美）；
 *  - 每日编舞种子表：日期种子决定慢拍担当/队形/节奏——同一天全仓同一场，每日有新鲜感；
 *  - 去武器：Avatar3D 已全场景隐藏武器节点。
 *
 * 触发类型（occasion）：first-install 首次装机欢迎 / morning 每日晨迎 / milestone 里程碑庆祝。
 * 离线渲染契约：?capture 模式由 window.__ceremonyStep 驱动虚拟时钟（录屏技能路线 B）。
 */
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { BusinessAvatar3D } from "../../components/BusinessAvatar3D";
import { AgentAvatarOf } from "../../components/AgentAvatar";
import { CineFloor, SpotBeam, CinePost } from "../../components/cinematic";

export interface CeremonyActor {
  presetKey: string;
  name: string;          // 岗位名（displayNameOf 已解析）
}

export type CeremonyOccasion = "first-install" | "morning" | "milestone";

/* ---------------- 每日编舞种子（同一天全仓同一场） ---------------- */
function daySeed(): number {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function seededRand(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

interface Choreography {
  slowDancers: number[];       // 慢半拍担当（员工索引）
  formation: "arc" | "line" | "v";
  cheerScale: number;          // 节奏（每日微变 1.05-1.25）
}

export function choreographyOf(actorCount: number, occasion: CeremonyOccasion): Choreography {
  const rand = seededRand(daySeed());
  const staffN = Math.max(0, actorCount - 1);
  const slowDancers: number[] = [];
  const slowN = Math.min(2, staffN);
  while (slowDancers.length < slowN) {
    const i = Math.floor(rand() * staffN);
    if (!slowDancers.includes(i)) slowDancers.push(i);
  }
  const formations: Array<Choreography["formation"]> = ["arc", "line", "v"];
  const formation = occasion === "first-install" ? "arc" : formations[Math.floor(rand() * formations.length)]!;
  const cheerScale = 1.05 + rand() * 0.2;
  return { slowDancers, formation, cheerScale };
}

/* ---------------- 布阵 ---------------- */
function formationPos(formation: Choreography["formation"], i: number, n: number): [number, number] {
  if (formation === "line") return [(i - (n - 1) / 2) * 1.5, -0.9];
  if (formation === "v") {
    const side = i % 2 === 0 ? -1 : 1;
    const rank = Math.ceil((i + 1) / 2);
    return [side * rank * 1.35, -0.6 - rank * 0.45];
  }
  // arc（默认）
  const x = (i - (n - 1) / 2) * 1.55;
  return [x, -0.9 - Math.abs(x) * 0.07];
}

/* ---------------- 单个演员 ---------------- */
function Actor({ actor, pos, isCeo, slow, cheerScale, dancing }: {
  actor: CeremonyActor;
  pos: [number, number];
  isCeo: boolean;
  slow: boolean;
  cheerScale: number;
  dancing: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const mixerRef = useRef<{ t: number }>({ t: 0 });

  useFrame((_, dt) => {
    if (!group.current) return;
    // 跳舞期群体律动（慢拍担当频率低 29% + 相位偏移）
    if (dancing) {
      const freq = slow ? 5.6 : 7.9;
      const phase = slow ? -1.2 : 0;
      mixerRef.current.t += dt;
      group.current.position.y = Math.abs(Math.sin(mixerRef.current.t * freq + phase)) * 0.07;
    } else {
      group.current.position.y *= 0.9;
    }
  });

  return (
    <group position={[pos[0], 0, pos[1]]}>
      <group ref={group} scale={isCeo ? 0.82 : 0.62}>
        <BusinessAvatar3D identity={actor.presetKey} state={dancing ? "celebrating" : "idle"} />
      </group>
      {/* 主光柱：CEO 金色常驻，员工仅里程碑场 */}
      {isCeo && <SpotBeam color="#ffd98a" height={4.6} topR={0.22} bottomR={0.95} opacity={0.1} />}
    </group>
  );
}

/* ---------------- 场景 ---------------- */
function CeremonyScene({ actors, occasion, dancing, onReady }: {
  actors: CeremonyActor[];
  occasion: CeremonyOccasion;
  dancing: boolean;
  onReady: () => void;
}) {
  const choreo = useMemo(() => choreographyOf(actors.length, occasion), [actors.length, occasion]);
  const readyFired = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!readyFired.current) { readyFired.current = true; onReady(); }
    }, 800);
    return () => clearTimeout(t);
  }, [onReady]);

  // 供离线渲染/测试读取编舞（同日全仓一致性验证）
  useEffect(() => {
    (window as unknown as { __choreography?: Choreography }).__choreography = choreo;
  }, [choreo]);

  return (
    <>
      <color attach="background" args={["#0b0d10"]} />
      <ambientLight intensity={0.55} color="#a8bce0" />
      <directionalLight position={[5, 8, 6]} intensity={1.0} color="#dce8ff" />
      <directionalLight position={[0, 3.5, 10]} intensity={0.7} color="#e8edf4" />
      <CineFloor radius={14} color="#0a0e16" mirror={0.5} night shape="square" lowRes />
      <gridHelper args={[24, 24, "#2c333b", "#1a1f26"]} position={[0, 0.005, 0]} />
      {/* 五道聚光（中央金） */}
      {[-4.4, -2.2, 0, 2.2, 4.4].map((x, i) => (
        <SpotBeam key={x} color={i === 2 ? "#ffd98a" : "#b3c6de"} height={7}
          topR={0.5} bottomR={1.6} opacity={i === 2 ? 0.1 : 0.07} position={[x, 0, -1]} />
      ))}

      {actors.map((a, i) => {
        const isCeo = i === 0;
        const pos: [number, number] = isCeo ? [0, 0.6] : formationPos(choreo.formation, i - 1, actors.length - 1);
        return (
          <Actor
            key={a.presetKey}
            actor={a}
            pos={pos}
            isCeo={isCeo}
            slow={!isCeo && choreo.slowDancers.includes(i - 1)}
            cheerScale={choreo.cheerScale}
            dancing={dancing}
          />
        );
      })}
      <CinePost bloom={0.45} grain={0.03} vignette={0.72} />
    </>
  );
}

/* ---------------- 主组件 ---------------- */
interface CeremonyStageProps {
  actors: CeremonyActor[];
  occasion?: CeremonyOccasion;
  dancing?: boolean;
  height?: number | string;
  onReady?: () => void;
}

function WebGLCeremonyStage({ actors, occasion = "first-install", dancing = true, height = 460, onReady }: CeremonyStageProps) {
  const [ready, setReady] = useState(false);
  return (
    <div data-ceremony-render-mode="webgl-3d" data-ceremony-ready={ready ? "true" : "false"} style={{ width: "100%", height, borderRadius: 12, overflow: "hidden", background: "#0b0d10", position: "relative" }}>
      <Canvas
        dpr={typeof window !== "undefined" ? window.devicePixelRatio : 1}
        camera={{ position: [0, 3.0, 13.5], fov: 38 }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
      >
        <Suspense fallback={null}>
          <CeremonyScene actors={actors} occasion={occasion} dancing={dancing} onReady={() => { setReady(true); onReady?.(); }} />
        </Suspense>
      </Canvas>
    </div>
  );
}

function hasWebGL(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("render") === "vector2d") return false;
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch { return false; }
}

/** WebGL 不可用时的动态团队舞台：人物、岗位、队形、舞蹈和聚光均保留。 */
function VectorCeremonyStage({ actors, occasion = "first-install", dancing = true, height = 460, onReady }: CeremonyStageProps) {
  const choreo = useMemo(() => choreographyOf(actors.length, occasion), [actors.length, occasion]);
  const stageRef = useRef<HTMLDivElement>(null);
  const ceoRef = useRef<HTMLDivElement>(null);
  const [ceoHeight, setCeoHeight] = useState(0);
  const [bounds, setBounds] = useState(() => ({
    width: typeof window === "undefined" ? 960 : window.innerWidth,
    height: typeof height === "number" ? height : typeof window === "undefined" ? 460 : window.innerHeight,
  }));
  const [activeActor, setActiveActor] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const actorIdentity = JSON.stringify(actors.map(({ presetKey, name }) => [presetKey, name]));
  const entryDelay = (index: number) => Math.min(index * 25, 600);
  const arrivalDuration = actors.length ? 580 + entryDelay(actors.length - 1) : 0;
  useEffect(() => {
    const measure = () => {
      const rect = stageRef.current?.getBoundingClientRect();
      const width = rect?.width || window.innerWidth;
      const measuredHeight = rect?.height || (typeof height === "number" ? height : window.innerHeight);
      setBounds((current) => current.width === width && current.height === measuredHeight
        ? current : { width, height: measuredHeight });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (stageRef.current) observer?.observe(stageRef.current);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [height]);
  useEffect(() => {
    // 与每个演员实际使用的 .58s 入场 + 最长 .6s 错峰共用时长。
    // 入场独立于舞蹈层，切换舞蹈或更换回调不会把全员就绪误报/重播。
    setReady(false);
    setActiveActor(null);
    const id = window.setTimeout(() => { setReady(true); readyCallback.current?.(); }, arrivalDuration);
    return () => window.clearTimeout(id);
  }, [actorIdentity, arrivalDuration]);

  const staff = actors.slice(1);
  const gridWidth = Math.max(1, bounds.width - Math.min(32, bounds.width * .04) * 2);
  const columns = Math.max(1, Math.min(16, staff.length || 1, Math.floor(gridWidth / 72)));
  const rows = Math.ceil(staff.length / columns);
  const gap = 8;
  const ceoSize = Math.round(Math.max(48, Math.min(128, bounds.width * .3, bounds.height * .18)));
  // 全屏仪式给上方横幅留出位置；普通嵌入舞台按自身高度分配。
  const ceoTop = Math.max(12, bounds.height >= 600 ? Math.max(230, bounds.height * .27) : bounds.height * .14);
  const detailSlotHeight = 60;
  // offsetHeight 读布局尺寸，避开入场/舞蹈 transform；字体加载后也重测姓名牌。
  useEffect(() => {
    const measure = () => {
      const measuredHeight = ceoRef.current?.offsetHeight ?? 0;
      setCeoHeight((current) => current === measuredHeight ? current : measuredHeight);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (ceoRef.current) observer?.observe(ceoRef.current);
    return () => observer?.disconnect();
  }, [ceoSize, gridWidth, actorIdentity]);
  const ceoBottom = ceoTop + (actors[0] ? ceoHeight || ceoSize + 36 : 0);
  const teamTop = Math.max(bounds.height * .48 - detailSlotHeight - gap, ceoBottom + 12);
  const gridTop = teamTop + detailSlotHeight + gap;
  const gridHeight = Math.max(48, bounds.height - gridTop - Math.max(12, Math.min(24, bounds.height * .025)));
  const cellWidth = (gridWidth - gap * (columns - 1)) / columns;
  const cellHeight = Math.max(48, Math.min(96, (gridHeight - gap * Math.max(0, rows - 1)) / Math.max(1, rows)));
  const avatarSize = Math.floor(Math.max(24, Math.min(64, cellWidth - 8, cellHeight - 12)));
  const scrollable = rows * cellHeight + gap * Math.max(0, rows - 1) > gridHeight;
  const selected = activeActor === null ? null : actors[activeActor];
  return (
    <div ref={stageRef} data-ceremony-render-mode="vector2d" data-ceremony-ready={ready ? "true" : "false"} data-ceremony-actors={String(actors.length)} data-ceremony-columns={String(columns)} data-ceremony-scrollable={String(scrollable)} style={{ width: "100%", height, borderRadius: 12, overflow: "hidden", background: "radial-gradient(ellipse at 50% 70%,#222b39 0,#0b0d10 58%)", position: "relative" }}>
      <style>{`
        @keyframes ceremony-v2-dance { 0%,100% { transform:translateY(0) rotate(-1deg); } 35% { transform:translateY(-6px) rotate(1.5deg); } 70% { transform:translateY(-2px) rotate(-1.2deg); } }
        @keyframes ceremony-v2-arrive { from { opacity:0; transform:translateY(70px) scale(.7); } to { opacity:1; transform:none; } }
        @keyframes ceremony-v2-beam { 0%,100% { opacity:.18; } 50% { opacity:.42; } }
        @media(prefers-reduced-motion:reduce) { [data-ceremony-actor], [data-ceremony-actor] span { animation:none !important; } }
        .ceremony-v2-member:hover { background:rgba(138,216,255,.07)!important; }
        .ceremony-v2-member:focus-visible { outline:2px solid #8ad8ff; outline-offset:-2px; background:rgba(138,216,255,.12)!important; }
        .ceremony-v2-member:active { background:rgba(138,216,255,.18)!important; }
      `}</style>
      <div style={{ position: "absolute", left: "8%", right: "8%", bottom: "8%", height: "18%", borderRadius: "50%", border: "1px solid rgba(255,217,138,.22)", background: "radial-gradient(ellipse,rgba(255,217,138,.11),transparent 70%)", transform: "perspective(500px) rotateX(64deg)" }} />
      {[18, 34, 50, 66, 82].map((left, i) => <div key={left} style={{ position: "absolute", left: `${left}%`, top: 0, width: "14%", height: "82%", transform: "translateX(-50%)", clipPath: "polygon(42% 0,58% 0,100% 100%,0 100%)", background: i === 2 ? "linear-gradient(rgba(255,217,138,.22),transparent)" : "linear-gradient(rgba(174,202,235,.12),transparent)", animation: `ceremony-v2-beam ${2.4 + i * .17}s ease-in-out infinite` }} />)}
      {actors[0] && <div ref={ceoRef} data-ceremony-actor={actors[0].presetKey} style={{ position: "absolute", left: "50%", top: ceoTop, width: Math.min(240, gridWidth), marginLeft: -Math.min(240, gridWidth) / 2, textAlign: "center", zIndex: 5, animation: "ceremony-v2-arrive .58s ease both" }}>
        <div style={{ animation: dancing ? "ceremony-v2-dance .94s ease-in-out infinite" : undefined }}>
          <AgentAvatarOf name={actors[0].name} presetKey={actors[0].presetKey} size={ceoSize} />
        </div>
        <div data-wl-meta data-product-nameplate="ceremony" className="truncate text-body" title={actors[0].name} style={{ display: "inline-block", maxWidth: "100%", marginTop: 3, padding: "3px 9px", borderRadius: 99, color: "#ffd98a", fontWeight: 750, lineHeight: 1.35, textShadow: "0 2px 10px #000", background: "rgba(7,12,22,.78)", border: "1px solid rgba(255,217,138,.34)" }}>{actors[0].name}</div>
      </div>}
      <div data-ceremony-layout style={{ position: "absolute", left: "50%", top: teamTop, transform: "translateX(-50%)", width: gridWidth, display: "flex", flexDirection: "column", gap, zIndex: 4 }}>
      <div data-ceremony-detail-slot style={{ height: detailSlotHeight, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {selected && <div data-product-nameplate="ceremony-detail" role="status" style={{ maxWidth: Math.min(400, gridWidth), maxHeight: detailSlotHeight, boxSizing: "border-box", overflowY: "auto", padding: "4px 12px", borderRadius: 12, color: "#e7eef8", fontSize: 13, lineHeight: 1.5, overflowWrap: "anywhere", textAlign: "center", background: "rgba(7,12,22,.94)", border: "1px solid rgba(138,216,255,.4)", boxShadow: "0 6px 18px rgba(0,0,0,.28)" }}>{selected.name}</div>}
      </div>
      <div data-ceremony-grid role="region" aria-label="团队欢迎名单，可滚动查看全部员工" tabIndex={0} style={{ width: gridWidth, height: gridHeight, flexShrink: 0, display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: cellHeight, rowGap: gap, columnGap: gap, alignContent: scrollable ? "start" : "center", overflowY: scrollable ? "auto" : "hidden", overflowX: "hidden" }}>
      {staff.map((actor, staffIndex) => {
        const index = staffIndex + 1;
        const slow = choreo.slowDancers.includes(staffIndex);
        return (
          <button key={`${actor.presetKey}-${index}`} type="button" data-ceremony-actor={actor.presetKey} className="ceremony-v2-member" aria-label={`查看${actor.name}`} aria-pressed={activeActor === index}
            onMouseEnter={() => setActiveActor(index)} onMouseLeave={(event) => { if (document.activeElement !== event.currentTarget) setActiveActor((current) => current === index ? null : current); }}
            onFocus={() => setActiveActor(index)} onBlur={() => setActiveActor((current) => current === index ? null : current)} onClick={() => setActiveActor(index)}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setActiveActor(null); } }}
            style={{ width: "100%", minWidth: 0, height: cellHeight, display: "flex", alignItems: "center", justifyContent: "center", padding: 6, border: 0, borderRadius: 10, background: "transparent", cursor: "pointer", animation: `ceremony-v2-arrive .58s ease ${entryDelay(index) / 1000}s both`, transformOrigin: "50% 100%" }}>
            <span style={{ display: "block", pointerEvents: "none", animation: dancing ? `ceremony-v2-dance ${slow ? 1.42 : .94}s ease-in-out ${index * .05}s infinite` : undefined }}><AgentAvatarOf name={actor.name} presetKey={actor.presetKey} size={avatarSize} /></span>
          </button>
        );
      })}
      </div>
      </div>
    </div>
  );
}

/** 团队仪式渲染后端选择器；安全模式仍是动态人物，不显示空舞台。 */
export function CeremonyStage(props: CeremonyStageProps) {
  // Live2D 与 R3F 同页切换时，部分 Chromium/ANGLE 组合会把前一上下文的纹理对象
  // 误带入新上下文（INVALID_OPERATION: object does not belong to this context），形成黑舞台。
  // 团队仪式因此以独立的动态矢量后端为正式路径；3D 仅保留给开发者显式验收。
  const experimental3D = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("team3d") === "1"
    && hasWebGL();
  return experimental3D ? <WebGLCeremonyStage {...props} /> : <VectorCeremonyStage {...props} />;
}
