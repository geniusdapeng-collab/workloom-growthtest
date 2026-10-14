import { describe, expect, it } from "vitest";
import { appendCinematicContract, auditCinematicContracts, buildCinematicContract, cinematicStyleRequested } from "./cinematic-contract.js";
const shot = (shotId = "s1") => ({ shotId, cinematic: {
  purpose: "show how the key unlocks the room", framing: "hand and lock fill lower third; doorway behind", depth: "key sharp; doorway readable",
  lighting: "window from left gives soft key; corridor practical behind", action: "insert key, turn, open door fully", camera: "hold as key turns, move through door after latch releases",
  artDirection: "brass key, worn lock and painted door share warm metal accents", sound: "key click and hinge movement; preserve room tone",
  continuity: { axis: "doorway left wall", screenDirection: "hand enters from right", entryState: "door closed", exitState: "door open" },
} });
describe("cinematic execution contract", () => {
  it("checks concrete photography, art, action and sound decisions", () => { const report = auditCinematicContracts([shot()], { required: true }); expect(report.pass).toBe(true); expect(report.evidence.pictureQuality).toBe("unverified"); });
  it("requires actual decisions for an explicit cinematic request", () => { const result = auditCinematicContracts([{ shotId: "s1", style: "cinematic" }], { required: true }); expect(result.pass).toBe(false); expect(result.issues[0]!.code).toBe("CINEMATIC_DECISIONS_MISSING"); });
  it("keeps missing information advisory for ordinary/reused shots", () => {
    expect(auditCinematicContracts([{ shotId: "old" }]).pass).toBe(true);
    expect(auditCinematicContracts([{ shotId: "old" }, shot("new")], { required: true, requiredShotIds: ["new"] }).pass).toBe(true);
  });
  it("derives existing source fields without choosing a director, light or lens", () => {
    const contract = buildCinematicContract({ shotId: "s", director_instruction: "reveal the queue", composition: "doorway wide", action: "queue advances", camera_movement: "static" });
    expect(contract.purpose).toBe("reveal the queue"); expect(contract.camera).toBe("static"); expect(contract.lighting).toBe(""); expect(contract.depth).toBe("");
  });
  it("detects state/axis jumps only on declared continuity matches", () => {
    const next = shot("s2"); next.cinematic.continuity = { ...next.cinematic.continuity, matchPreviousShotId: "s1" } as never;
    expect(auditCinematicContracts([shot(), next], { required: true }).issues.map((e) => e.code)).toContain("CINEMATIC_STATE_JUMP");
    (next.cinematic.continuity as unknown as Record<string, unknown>).transitionReason = "cut back before the action to show another key";
    expect(auditCinematicContracts([shot(), next], { required: true }).pass).toBe(true);
  });
  it("does not accept forward or unknown continuity references", () => {
    const s = shot(); (s.cinematic.continuity as unknown as Record<string, unknown>).matchPreviousShotId = "future";
    expect(auditCinematicContracts([s], { required: true }).pass).toBe(false);
  });
  it("rejects duplicate/empty ids even for natural style", () => { expect(auditCinematicContracts([shot(), shot()]).pass).toBe(false); expect(auditCinematicContracts([{ shotId: "" }]).pass).toBe(false); });
  it("binds source changes and replaces obsolete prompt decisions idempotently", () => {
    const s = shot(); const c = buildCinematicContract(s); const p = appendCinematicContract("base", c); expect(appendCinematicContract(p, c)).toBe(p);
    s.cinematic.lighting = "single overhead shop practical"; const next = appendCinematicContract(p, buildCinematicContract(s));
    expect(next).toContain(s.cinematic.lighting); expect(next).not.toContain("window from left"); expect(next.match(/【摄影执行合同 [a-f0-9]{64}】/g)).toHaveLength(1);
  });
  it("a plate gets spatial decisions; movement and sound stay in the video route", () => {
    const c = buildCinematicContract(shot()); const plate = appendCinematicContract("base", c, "plate"); const video = appendCinematicContract("base", c);
    expect(plate).toContain(c.framing); expect(plate).not.toContain(c.camera); expect(plate).not.toContain(c.sound); expect(video).toContain(c.camera); expect(video).toContain(c.sound);
  });
  it("recognizes explicit production requests without guessing from arbitrary prose", () => {
    expect(cinematicStyleRequested({ productionStyle: "cinematic" })).toBe(true); expect(cinematicStyleRequested({ filmStyle: "大片感" })).toBe(true); expect(cinematicStyleRequested({ title: "cinematic clip" })).toBe(false);
  });
  it("keeps postproduction score instructions from leaking back into generated programme sound", () => {
    const s = shot(); s.cinematic.sound = "key click；背景音乐使用交响配乐";
    const contract = buildCinematicContract(s); expect(contract.sound).toContain("key click"); expect(contract.sound).not.toContain("交响配乐");
    expect(auditCinematicContracts([s], { required: true }).issues.map(issue => issue.code)).toContain("CINEMATIC_SOUND_BGM_CONFLICT");
    expect(auditCinematicContracts([s]).pass).toBe(true);
  });
  it("avoids repeating decisions already present in the formal prompt", () => {
    const c = buildCinematicContract(shot()), base = `【场景】${c.artDirection}\n【灯光】${c.lighting}`;
    const prompt = appendCinematicContract(base, c); expect(prompt.split(c.lighting)).toHaveLength(2); expect(prompt.split(c.artDirection)).toHaveLength(2);
    expect(prompt).toContain(c.framing); expect(appendCinematicContract(prompt, c)).toBe(prompt);
  });
});
