/**
 * archive/store.test.ts —— 档案存储单元测试（T-2026-0926-0001）
 * 覆盖：manifest 初始化 / 原子写摘要 / append-only JSONL / 路径监狱 / attempt 清单 / 账本更新。
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARCHIVE_SCHEMA_VERSION, ArchiveStore, assertInsideRoot } from "./store.js";

let workDir = "";
let store: ArchiveStore;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "archive-store-"));
  store = new ArchiveStore(workDir, "ws-test", "VID-001", "marketing", { aspectRatio: "9:16" });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("ArchiveStore", () => {
  it("ensure() 建档案夹并按管线类型写 manifest", async () => {
    await store.ensure();
    const manifest = await store.readManifest();
    expect(manifest?.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
    expect(manifest?.pipelineKind).toBe("marketing");
    expect(manifest?.routeMeta).toEqual({ aspectRatio: "9:16" });
    expect(manifest?.ledger).toEqual({});
    expect(store.root).toBe(path.join(workDir, "archive", "ws-test", "VID-001"));
  });

  it("ensure() 幂等：已存在的 manifest 不被覆盖（历史不丢）", async () => {
    await store.ensure();
    await store.updateLedger("preproduction", { attempt: 1, status: "done", finishedAt: null });
    await store.ensure();
    const manifest = await store.readManifest();
    expect(manifest?.ledger.preproduction).toEqual({ attempt: 1, status: "done", finishedAt: null });
  });

  it("writeJsonAtomic 落盘并返回 sha256（内容一致）", async () => {
    await store.ensure();
    const { sha256 } = await store.writeJsonAtomic("stages/x/attempt-1.output.json", { a: 1 });
    const body = await readFile(path.join(store.root, "stages/x/attempt-1.output.json"), "utf8");
    expect(JSON.parse(body)).toEqual({ a: 1 });
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    // tmp 文件不残留
    await expect(readFile(path.join(store.root, "stages/x/attempt-1.output.json.tmp"), "utf8")).rejects.toThrow();
  });

  it("appendJsonl 追加且自动带 ts（append-only）", async () => {
    await store.ensure();
    await store.appendJsonl("events.jsonl", { kind: "stage.start", stageId: "s1", attempt: 1 });
    await store.appendJsonl("events.jsonl", { kind: "stage.done", stageId: "s1", attempt: 1 });
    const events = await store.readEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("stage.start");
    expect(typeof events[0]?.ts).toBe("string");
  });

  it("readEvents 跳过坏行（半行写入不炸监控器）", async () => {
    await store.ensure();
    await store.appendJsonl("events.jsonl", { kind: "ok" });
    await writeFile(path.join(store.root, "events.jsonl"), '{"kind":"ok"}\n{"broken"\n', { flag: "a" });
    const events = await store.readEvents();
    expect(events).toHaveLength(2); // 两条合法行可读，坏行被跳过
    expect(events.map((e) => e.kind)).toEqual(["ok", "ok"]);
  });

  it("路径监狱：拒绝绝对路径与 ../ 越界", async () => {
    await store.ensure();
    expect(() => assertInsideRoot(store.root, "/etc/passwd")).toThrow(/相对路径/);
    await expect(store.writeJsonAtomic("../../escape.json", { a: 1 })).rejects.toThrow(/越出档案根/);
    await expect(store.readJson("../../etc/passwd")).resolves.toBeNull();
  });

  it("listAttempts 按 attempt 归组（历史 attempt 全部可见）", async () => {
    await store.ensure();
    await store.writeJsonAtomic("stages/preproduction/attempt-1.input.json", { n: 1 });
    await store.writeJsonAtomic("stages/preproduction/attempt-1.meta.json", { errorClass: "BUG" });
    await store.writeJsonAtomic("stages/preproduction/attempt-2.input.json", { n: 2 });
    const attempts = await store.listAttempts("preproduction");
    expect(attempts.map((row) => row.attempt)).toEqual([1, 2]);
    expect(attempts[0]?.files).toEqual(["attempt-1.input.json", "attempt-1.meta.json"]);
  });

  it("updateLedger 在 manifest 缺失时静默返回（旁路不阻断）", async () => {
    await mkdir(store.root, { recursive: true });
    await expect(store.updateLedger("s1", { attempt: 1, status: "running", finishedAt: null })).resolves.toBeUndefined();
  });

  it("snapshotExternalDir 只读快照外部运行态目录（断点证据留底）", async () => {
    await store.ensure();
    const external = path.join(workDir, "checkpoints", "VID-001");
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, "checkpoint-phase1.json"), JSON.stringify({ phase: "phase1", shots: [1, 2] }));
    await writeFile(path.join(external, "notes.txt"), "不应被快照（filter 只收 .json）");

    const result = await store.snapshotExternalDir(external, "checkpoints/attempt-2-before", {
      filter: (name) => name.endsWith(".json"),
    });
    expect(result.files).toBe(1);
    const copied = await store.readJson<{ phase: string }>("checkpoints/attempt-2-before/checkpoint-phase1.json");
    expect(copied?.phase).toBe("phase1");
    // 源目录不受影响（只读快照）
    expect(JSON.parse(await readFile(path.join(external, "checkpoint-phase1.json"), "utf8")).phase).toBe("phase1");
    // 目标必须在档案根内
    await expect(store.snapshotExternalDir(external, "../escape")).rejects.toThrow(/越出档案根/);
  });

  it("snapshotExternalDir 源目录不存在时返回空（旁路不阻断）", async () => {
    await store.ensure();
    await expect(store.snapshotExternalDir(path.join(workDir, "nope"), "checkpoints/x")).resolves.toEqual({
      files: 0, bytes: 0, skipped: [],
    });
  });

  it("ensure(identity)：档案夹被另一代 DB 的同名 projectId 复用时留痕并校正 kind（D1 修复）", async () => {
    // 第一代：叙事片建档案
    const narrativeStore = new ArchiveStore(workDir, "ws-test", "VID-001", "narrative");
    await narrativeStore.ensure({ kind: "narrative", title: "第一代片子", createdAt: "2026-09-26T10:00:00.000Z" });
    const first = await narrativeStore.readManifest();
    expect(first?.pipelineKind).toBe("narrative");
    expect(first?.projectIdentity).toEqual({ kind: "narrative", title: "第一代片子", createdAt: "2026-09-26T10:00:00.000Z" });

    // 第二代：同一 (ws, projectId) 被营销片复用（换库/重置种子的真实场景）
    const marketingStore = new ArchiveStore(workDir, "ws-test", "VID-001", "marketing", { aspectRatio: "9:16" });
    await marketingStore.ensure({ kind: "marketing", title: "第二代片子", createdAt: "2026-09-26T13:00:00.000Z" });

    const after = await marketingStore.readManifest();
    expect(after?.pipelineKind).toBe("marketing"); // 校正为本次 run 的真实值
    expect(after?.pipelineKindHistory?.map((h) => h.kind)).toEqual(["narrative", "marketing"]);
    expect(after?.identityDrifts).toHaveLength(1);
    expect(after?.identityDrifts?.[0]).toMatchObject({
      previousKind: "narrative",
      currentKind: "marketing",
      previousIdentity: { createdAt: "2026-09-26T10:00:00.000Z" },
      currentIdentity: { createdAt: "2026-09-26T13:00:00.000Z" },
    });
    const events = await marketingStore.readEvents();
    expect(events.map((e) => e.kind)).toContain("manifest.identity_drift");
    // 历史产物不被抹掉
    expect(await marketingStore.readManifest()).toBeTruthy();
  });

  it("ensure(identity)：身份一致时不产生漂移记录（不误报）", async () => {
    const identity = { kind: "marketing" as const, title: "同一部片子", createdAt: "2026-09-26T10:00:00.000Z" };
    await store.ensure(identity);
    await store.ensure(identity);
    const manifest = await store.readManifest();
    expect(manifest?.identityDrifts ?? []).toHaveLength(0);
    expect(manifest?.pipelineKindHistory).toHaveLength(1);
  });
});
