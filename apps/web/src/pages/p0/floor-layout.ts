import { roleTitleOf } from "../../lib/naming";
import type { FloorAgent, FloorPayload, FloorScene } from "./Floor";

export const FLOOR_STATE_TEXT: Record<FloorAgent["state"], string> = {
  working: "进行中", asking: "待放行", blocked: "有异常", celebrating: "已完成",
  collab: "协作中", queued: "排队中", idle: "待命", disabled: "已停用",
};
export const FLOOR_ROLE_FONT = "700 9.5px sans-serif";
export const FLOOR_STATUS_FONT = "8px sans-serif";
export interface FloorRect { x: number; y: number; width: number; height: number }
export interface FloorSlot {
  id: string; x: number; y: number; sx: number; sy: number;
  roleLines: string[]; stateLines: string[]; card: FloorRect; bounds: FloorRect;
}
export interface FloorLayout {
  width: number; height: number; tileW: number; tileH: number; cx: number; cy: number;
  slots: Map<string, FloorSlot>;
}

export function floorProjection(width: number, height: number, scene: FloorScene) {
  const span = scene.grid.w + scene.grid.h;
  const tileW = Math.min(width * 1.84 / span, height * 3.12 / span);
  return { tileW, tileH: tileW / 2, cx: width / 2, cy: height * .1 };
}

export function floorRectsOverlap(a: FloorRect, b: FloorRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Center a real employee card, close to the team's center, when the scene first expands. */
export function floorInitialScroll(cards: FloorRect[], viewportWidth: number, viewportHeight: number, contentWidth: number, contentHeight: number) {
  if (!cards.length) return { left: 0, top: 0 };
  const centerX = cards.reduce((sum, card) => sum + card.x + card.width / 2, 0) / cards.length;
  const centerY = cards.reduce((sum, card) => sum + card.y + card.height / 2, 0) / cards.length;
  const focus = cards.reduce((best, card) => Math.hypot(card.x + card.width / 2 - centerX, card.y + card.height / 2 - centerY)
    < Math.hypot(best.x + best.width / 2 - centerX, best.y + best.height / 2 - centerY) ? card : best);
  return {
    left: Math.max(0, Math.min(contentWidth - viewportWidth, focus.x + focus.width / 2 - viewportWidth / 2)),
    top: Math.max(0, Math.min(contentHeight - viewportHeight, focus.y + focus.height / 2 - viewportHeight / 2)),
  };
}

function preferredPosition(agent: FloorAgent, scene: FloorScene) {
  const station = scene.stations.find(item => item.id === agent.stationId);
  if (agent.state === "asking") return { x: scene.ceoDesk.x, y: scene.ceoDesk.y + 1.1 };
  if (station) return { x: station.x, y: station.y + (agent.state === "blocked" ? .7 : .4) };
  if (agent.state === "blocked") return { x: scene.grid.w / 2, y: scene.grid.h / 2 };
  return scene.lounge;
}

/** TextMetrics can extend beyond advance width. Reserve both sides of centered text. */
function textWidth(ctx: CanvasRenderingContext2D, text: string): number {
  const metrics = ctx.measureText(text);
  return Math.max(metrics.width, (metrics.actualBoundingBoxLeft || 0) * 2, (metrics.actualBoundingBoxRight || 0) * 2);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, limit = 180): string[] {
  const lines: string[] = [];
  let line = "";
  for (const character of Array.from(text)) {
    if (line && textWidth(ctx, line + character) > limit) { lines.push(line); line = character; }
    else line += character;
  }
  lines.push(line);
  return lines;
}

/** Allocate once per payload/viewport change, in CSS pixels; animation never moves plaques. */
export function createFloorLayout(floor: FloorPayload, viewportWidth: number, viewportHeight: number, ctx: CanvasRenderingContext2D): FloorLayout {
  if (![floor.scene.grid.w, floor.scene.grid.h, viewportWidth, viewportHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError("Invalid floor or viewport dimensions");
  }
  ctx.textAlign = "center";
  const labels = floor.agents.filter(agent => agent.state !== "disabled").map(agent => {
    ctx.font = FLOOR_ROLE_FONT;
    const roleLines = wrapText(ctx, roleTitleOf(agent.name, agent.presetKey));
    const roleWidth = Math.max(...roleLines.map(line => textWidth(ctx, line)));
    const title = Array.from(agent.currentThread?.title ?? "");
    const stateLabel = FLOOR_STATE_TEXT[agent.state] + (agent.currentThread ? ` · ${title.slice(0, 14).join("")}${title.length > 14 ? "…" : ""}` : "");
    ctx.font = FLOOR_STATUS_FONT;
    const stateLines = wrapText(ctx, stateLabel);
    const width = Math.ceil(Math.max(32, roleWidth + 12, ...stateLines.map(line => textWidth(ctx, line) + 12)));
    const height = 21 + (roleLines.length + stateLines.length - 2) * 11;
    const top = agent.state === "asking" || agent.state === "blocked" ? 60 : agent.state === "celebrating" ? 44 : agent.state === "working" ? 42 : 32;
    return { agent, roleLines, stateLines, width, height, top };
  }).sort((a, b) => b.width * (b.height + b.top) - a.width * (a.height + a.top) || a.agent.id.localeCompare(b.agent.id));

  let width = Math.max(320, Math.round(viewportWidth));
  let height = Math.max(240, Math.round(viewportHeight));
  // A crowded/long-name scene grows inside its scroll container, never shrinking text or hiding employees.
  for (let attempt = 0; attempt < 20; attempt++) {
    const projection = floorProjection(width, height, floor.scene);
    const { tileW, tileH, cx, cy } = projection;
    const project = (x: number, y: number) => ({ sx: cx + (x - y) * tileW / 2, sy: cy + (x + y) * tileH / 2 });
    const ceo = project(floor.scene.ceoDesk.x, floor.scene.ceoDesk.y);
    const occupied: FloorRect[] = [{ x: ceo.sx - 38, y: ceo.sy - 48, width: 76, height: 70 }];
    const candidates: Array<{ x: number; y: number; sx: number; sy: number }> = [];
    for (let sy = 40; sy <= height - 26; sy += 8) for (let sx = 16; sx <= width - 16; sx += 8) {
      const sum = (sy - cy) * 2 / tileH, difference = (sx - cx) * 2 / tileW;
      const x = (sum + difference) / 2, y = (sum - difference) / 2;
      if (x >= .15 && x <= floor.scene.grid.w - .15 && y >= .15 && y <= floor.scene.grid.h - .15) candidates.push({ x, y, sx, sy });
    }
    const slots = new Map<string, FloorSlot>();
    for (const label of labels) {
      const preferred = preferredPosition(label.agent, floor.scene);
      const anchor = project(preferred.x, preferred.y);
      let best: (typeof candidates)[number] | undefined;
      let nearest = Infinity;
      for (const point of candidates) {
        const distance = (point.sx - anchor.sx) ** 2 + (point.sy - anchor.sy) ** 2;
        if (distance >= nearest) continue;
        const bounds = { x: point.sx - label.width / 2 - 4, y: point.sy - label.top, width: label.width + 8, height: label.top + 6 + label.height + 4 };
        if (bounds.x < 8 || bounds.y < 8 || bounds.x + bounds.width > width - 8 || bounds.y + bounds.height > height - 8 || occupied.some(item => floorRectsOverlap(bounds, item))) continue;
        best = point; nearest = distance;
      }
      if (!best) break;
      const bounds = { x: best.sx - label.width / 2 - 4, y: best.sy - label.top, width: label.width + 8, height: label.top + 6 + label.height + 4 };
      occupied.push(bounds);
      slots.set(label.agent.id, { id: label.agent.id, ...best, roleLines: label.roleLines, stateLines: label.stateLines,
        card: { x: best.sx - label.width / 2, y: best.sy + 6, width: label.width, height: label.height }, bounds });
    }
    if (slots.size === labels.length) return { width, height, ...projection, slots };
    width = Math.ceil(width * 1.16);
    height = Math.max(Math.ceil(height * 1.16), Math.ceil(width * .56));
  }
  throw new RangeError("Floor content exceeds the available canvas layout");
}
