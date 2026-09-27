import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { filmReviewContracts, loadOrCreateFilmAuthorContext, reviewFilmStage, storyDateAt, type FilmContractSource } from "./film-contracts.js";
import { resolveEraProfile } from "./era-profile.js";
import { buildProducerReviewContract, type ProducerGateOptions, type ProducerVerdict } from "./producer-gate.js";
const dirs: string[] = [];
function directory(): string { const dir = mkdtempSync(join(tmpdir(), "film-context-")); dirs.push(dir); return dir; }
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const empty = { shotId: "E", scene: "海边空镜，无人物", lighting: "日落天光", environmentProfile: { setting: "exterior", condition: "natural" } };
const source = (): FilmContractSource => ({ projectId: "project", shots: [structuredClone(empty)], eraProfile: resolveEraProfile({ storyDate: "2026-09-28" }) });
function approved(options: ProducerGateOptions): ProducerVerdict {
  return { stage: options.stage, status: "passed", approved: true, score: 91, hardFailures: [], issues: [], suggestions: [], rerun: false,
    via: "llm", ms: 1, reason: "test evidence", degraded: false, contractHash: buildProducerReviewContract(options.contracts!).contractHash };
}
const options = (): Omit<ProducerGateOptions, "contracts"> => ({ stage: "continuity", projectId: "project", artifacts: [], deterministic: [] });

describe("first-authored frozen film context", () => {
  it("uses Asia/Shanghai date and keeps it on later reruns", () => {
    const path = join(directory(), "context.json");
    const first = loadOrCreateFilmAuthorContext({ path, projectId: "project", now: new Date("2026-09-27T17:00:00Z") });
    expect(first.eraProfile).toMatchObject({ storyDate: "2026-09-28", devicePolicy: "story-compatible" });
    const bytes = readFileSync(path, "utf8");
    expect(loadOrCreateFilmAuthorContext({ path, projectId: "project", now: new Date("2027-04-01T00:00:00Z") })).toEqual(first);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(storyDateAt(new Date("2026-09-27T15:59:59Z"))).toBe("2026-09-27");
  });
  it("preserves explicit historical and brand facts", () => {
    for (const eraProfile of [{ storyDate: "1995-03-01" }, { storyDate: "2025-09-01", devicePolicy: "apple-2024plus" }]) {
      const path = join(directory(), "context.json");
      expect(loadOrCreateFilmAuthorContext({ path, projectId: "project", eraProfile }).eraProfile).toMatchObject(eraProfile);
      expect(loadOrCreateFilmAuthorContext({ path, projectId: "project" }).eraProfile).toMatchObject(eraProfile);
    }
  });
  it("rejects project mismatch and changed explicit era instead of silently overwriting", () => {
    const path = join(directory(), "context.json");
    loadOrCreateFilmAuthorContext({ path, projectId: "project", eraProfile: { storyDate: "2024-01-01" } });
    const bytes = readFileSync(path, "utf8");
    expect(() => loadOrCreateFilmAuthorContext({ path, projectId: "other" })).toThrow("SCOPE_MISMATCH");
    expect(() => loadOrCreateFilmAuthorContext({ path, projectId: "project", eraProfile: { storyDate: "2025-01-01" } })).toThrow("ERA_CONFLICT");
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
  it.each(["", "{", "[]", JSON.stringify({ schemaVersion: "old", projectId: "project" })])("rejects damaged existing bytes %j", (bytes) => {
    const path = join(directory(), "context.json"); writeFileSync(path, bytes);
    expect(() => loadOrCreateFilmAuthorContext({ path, projectId: "project" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
  it("rejects symlink context, unknown profile fields and invalid author date", () => {
    const dir = directory(); const target = join(dir, "target"); writeFileSync(target, "safe"); symlinkSync(target, join(dir, "context"));
    expect(() => loadOrCreateFilmAuthorContext({ path: join(dir, "context"), projectId: "project" })).toThrow();
    expect(readFileSync(target, "utf8")).toBe("safe");
    expect(() => loadOrCreateFilmAuthorContext({ path: join(dir, "new"), projectId: "../bad" })).toThrow("PROJECT_INVALID");
    expect(() => loadOrCreateFilmAuthorContext({ path: join(dir, "new"), projectId: "project", eraProfile: { storyDate: "2025-02-29" } })).toThrow();
    expect(() => storyDateAt(new Date("invalid"))).toThrow("DATE_INVALID");
  });
  it("independent first-author processes observe one complete frozen context", async () => {
    const dir = directory(); const path = join(dir, "context.json");
    const module = new URL("./film-contracts.ts", import.meta.url).href;
    const runs = Array.from({ length: 8 }, (_, index) => new Promise<string>((resolve, reject) => {
      const code = `import {loadOrCreateFilmAuthorContext as f} from ${JSON.stringify(module)}; console.log(JSON.stringify(f({path:${JSON.stringify(path)},projectId:'project',now:new Date('2026-09-${20 + index}T00:00:00Z')})))`;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code]);
      let out = "", err = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
    }));
    const values = await Promise.all(runs);
    expect(new Set(values).size).toBe(1); expect(JSON.parse(values[0]!)).toEqual(JSON.parse(readFileSync(path, "utf8")));
    expect(readdirSync(dir)).toEqual(["context.json"]);
  }, 20_000);
});

describe("full source contracts reach each review", () => {
  it("selects one original shot without losing its local era or special text, and does not mutate it", () => {
    const s = source(); s.shots.push({ ...empty, shotId: "FLASH", eraProfile: { storyDate: "1995-01-01" }, action: '原文\n"片尾约束"<> &' });
    const contracts = filmReviewContracts(s, "FLASH");
    expect(contracts.shots).toEqual([s.shots[1]]); (contracts.shots[0]!).action = "different";
    expect(s.shots[1]!.action).toContain("片尾约束");
    expect(() => filmReviewContracts(s, "missing")).toThrow("SCOPE_INVALID");
  });
  it("passes complete raw facts to the actual producer model body and binds the result hash", async () => {
    const s = source(); s.shots[0]!.customAuthorFact = "原稿尾部不能遗漏的约束";
    const file = join(directory(), "script.json"); writeFileSync(file, JSON.stringify(s.shots));
    let body = "";
    const v = await reviewFilmStage(s, { ...options(), artifacts: [{ path: file, kind: "json" }],
      env: { LLM_BASE_URL: "https://judge.invalid", LLM_API_KEY: "test", LLM_MODEL: "judge" },
      fetchImpl: (async (_url: unknown, init: RequestInit) => { body = String(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ approved: true, score: 90, issues: [], suggestions: [], reason: "actual body captured" }) } }] })); }) as typeof fetch });
    expect(v.approved, v.reason).toBe(true); expect(body).toContain("原稿尾部不能遗漏的约束"); expect(body).toContain("authorContracts");
    expect(v.contractHash).toBe(buildProducerReviewContract(filmReviewContracts(s)).contractHash);
  });
  it("rejects unknown shot/project before invoking review", async () => {
    let calls = 0; const reviewer = async (o: ProducerGateOptions) => { calls++; return approved(o); };
    await expect(reviewFilmStage(source(), { ...options(), context: { shotId: "missing" } }, reviewer)).rejects.toThrow("SCOPE_INVALID");
    await expect(reviewFilmStage(source(), { ...options(), projectId: "other" }, reviewer)).rejects.toThrow("PROJECT_MISMATCH");
    expect(calls).toBe(0);
  });
  it("cannot approve a missing/wrong hash or changed author facts", async () => {
    for (const hash of [undefined, "0".repeat(64)]) {
      const v = await reviewFilmStage(source(), options(), async (o) => ({ ...approved(o), contractHash: hash }));
      expect(v).toMatchObject({ approved: false, status: "unverified", reason: "FILM_REVIEW_CONTRACT_MISMATCH" });
    }
    const s = source(); const v = await reviewFilmStage(s, options(), async (o) => { const result = approved(o); s.shots[0]!.action = "源已变化"; return result; });
    expect(v.approved).toBe(false);
  });
  it("preserves explicit rejection and passes full source registry for project review", async () => {
    const s = source(); s.shots.push({ ...empty, shotId: "TWO" });
    const v = await reviewFilmStage(s, options(), async (o) => { expect(o.contracts!.shots).toHaveLength(2); return { ...approved(o), approved: false, status: "failed", reason: "original reject" }; });
    expect(v.reason).toBe("original reject"); expect(v.approved).toBe(false);
  });
});
