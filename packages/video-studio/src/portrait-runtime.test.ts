import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPortraitRuntime, REQUIRED_ANGLES } from "./portrait-runtime.js";

/** 假 Seedream：出图返回 URL，下载返回固定图片字节 */
function fakeArk(options: { failStatus?: number } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/images/generations")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      if (options.failStatus) {
        return new Response("参数被拒", { status: options.failStatus });
      }
      return new Response(
        JSON.stringify({ data: [{ url: "https://cdn.example.invalid/out.png", size: "2K" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // 产物下载
    return new Response(new Uint8Array(4096).fill(7), {
      status: 200,
      headers: { "content-type": "image/png" }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const temporaryDirs: string[] = [];
afterEach(() => { for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wl-portrait-")); temporaryDirs.push(dir); return dir;
}

function writeRef(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, Buffer.alloc(2048, 3));
  return file;
}

describe("定妆照真实出图运行时", () => {
  it("角色角度按渲染核心口径落盘，并写入索引", async () => {
    const root = workDir();
    const { fetchImpl, calls } = fakeArk();
    const runtime = createPortraitRuntime({
      workDir: root,
      projectId: "VID-9999",
      apiKey: "test-key",
      model: "doubao-seedream-5-0-pro-260628",
      size: "2K",
      fetchImpl
    });

    const file = await runtime.apiRender({
      portraitId: "住客-front_full",
      characterId: "住客",
      characterName: "住客",
      angle: "front_full",
      prompt: "【定妆照】住客 — 正面全身"
    });

    // 目录名 ASCII 化，文件名命中 REQUIRED_ANGLES 的 front
    expect(file.endsWith("-front.png")).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).byteLength).toBe(4096);

    const indexFile = runtime.indexPath();
    expect(existsSync(indexFile)).toBe(true);
    const index = JSON.parse(readFileSync(indexFile, "utf8")) as {
      characters: Record<string, { files: Record<string, string> }>;
    };
    const keys = Object.keys(index.characters);
    expect(keys).toHaveLength(1);
    expect(index.characters[keys[0]!]!.files.front).toBe(file);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.model).toBe("doubao-seedream-5-0-pro-260628");
    expect(calls[0]!.body.size).toBe("2K");
  });

  it("同一角色角度重复出图复用已落盘文件（幂等，不再烧额度）", async () => {
    const root = workDir();
    const { fetchImpl, calls } = fakeArk();
    const runtime = createPortraitRuntime({
      workDir: root, projectId: "VID-9999", apiKey: "k", model: "m", fetchImpl
    });
    const task = { characterId: "导游", characterName: "导游", angle: "three_quarter" };
    const first = await runtime.apiRender(task);
    const second = await runtime.apiRender(task);
    expect(second).toBe(first);
    expect(first.endsWith("-threeQuarter.png")).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("四个必需角度可齐备（绑定清单前置条件）", async () => {
    const root = workDir();
    const { fetchImpl } = fakeArk();
    const runtime = createPortraitRuntime({
      workDir: root, projectId: "VID-9999", apiKey: "k", model: "m", fetchImpl
    });
    for (const angle of ["front_full", "face_closeup", "three_quarter", "side_full"]) {
      await runtime.apiRender({ characterId: "导游", characterName: "导游", angle });
    }
    const keys = Object.keys(runtime.snapshot().characters);
    expect(keys).toHaveLength(1);
    const entry = runtime.snapshot().characters[keys[0]!]!;
    for (const required of REQUIRED_ANGLES) {
      const file = entry.files[required];
      expect(file).toBeTruthy();
      expect(existsSync(String(file))).toBe(true);
    }
  });

  it("出图失败（400）直接抛错，不写假文件", async () => {
    const root = workDir();
    const { fetchImpl } = fakeArk({ failStatus: 400 });
    const runtime = createPortraitRuntime({
      workDir: root, projectId: "VID-9999", apiKey: "k", model: "m", fetchImpl, retries: 0
    });
    await expect(runtime.apiRender({ characterId: "住客", angle: "front_full" })).rejects.toThrow(/HTTP 400/);
    expect(Object.keys(runtime.snapshot().characters)).toHaveLength(0);
  });

  /**
   * 真机回归（2026-09-21）：vendor 角色分支只传 `portraitId + angle + prompt`，
   * 早先实现把非 ASCII 名压成 "-" → `住客-three_quarter` 退化成 `three_quarter`，
   * 三个角色的定妆照互相覆盖还被归到商品桶。这里锁死"按角色归桶 + 名字回填"。
   */
  it("vendor 真实角色任务形状按角色归桶，不再退化成角度名", async () => {
    const root = workDir();
    const { fetchImpl } = fakeArk();
    const runtime = createPortraitRuntime({
      workDir: root, projectId: "VID-9999", apiKey: "k", model: "m", fetchImpl
    });
    const first = await runtime.apiRender({
      portraitId: "char_001-front_full",
      angle: "front_full",
      angleName: "正面全身",
      prompt: "【定妆照】引路学者 — 正面全身\n角色档案：深灰民国长衫，全息透明轮廓"
    });
    const second = await runtime.apiRender({
      portraitId: "char_002-front_full",
      angle: "front_full",
      angleName: "正面全身",
      prompt: "【定妆照】公馆记忆体 — 正面全身\n角色档案：半透明历史照片碎片"
    });

    expect(first).toMatch(/\/char_001\/portraits\/char_001-[a-f0-9]{64}-front\.png$/);
    expect(second).toMatch(/\/char_002\/portraits\/char_002-[a-f0-9]{64}-front\.png$/);
    expect(first).not.toBe(second);
    const characters = runtime.snapshot().characters;
    expect(Object.keys(characters).sort()).toEqual(["char_001", "char_002"]);
    expect(characters["char_001"]!.name).toBe("引路学者");
    expect(characters["char_002"]!.name).toBe("公馆记忆体");
    expect(Object.keys(runtime.snapshot().products)).toHaveLength(0);
  });

  it("参考图预填与基准图直通（服务类链路锚定真实实拍）", async () => {
    const root = workDir();
    const refsDir = join(root, "refs");
    mkdirSync(refsDir, { recursive: true });
    const ref1 = writeRef(refsDir, "ref-01.jpg");
    const ref2 = writeRef(refsDir, "ref-02.jpg");
    const missing = join(refsDir, "ref-99.jpg");
    const { fetchImpl } = fakeArk();
    const runtime = createPortraitRuntime({
      workDir: root, projectId: "VID-9999", apiKey: "k", model: "m",
      referenceImages: [ref1, ref2, missing], fetchImpl
    });

    expect(await runtime.searchReferences({})).toEqual([ref1, ref2]);
    const base = await runtime.processImage({}, []);
    expect(existsSync(base)).toBe(true);
    expect(readFileSync(base).byteLength).toBe(2048);
  });

  it("商品定妆照携带参考图（≤4 张，走 image 字段）", async () => {
    const root = workDir();
    const refsDir = join(root, "refs");
    mkdirSync(refsDir, { recursive: true });
    const refs = [1, 2, 3, 4, 5].map((n) => writeRef(refsDir, `ref-0${n}.jpg`));
    const { fetchImpl, calls } = fakeArk();
    const runtime = createPortraitRuntime({
      workDir: root, projectId: "VID-9999", apiKey: "k", model: "m",
      referenceImages: refs, maxReferenceImages: 4, fetchImpl
    });

    await runtime.apiRender({ productId: "suzhou-nanyuan-hotel", productName: "苏州南园宾馆", view: "brand_hero" });
    expect(calls).toHaveLength(1);
    const image = calls[0]!.body.image as string[] | string;
    expect(Array.isArray(image)).toBe(true);
    expect((image as string[]).length).toBe(4);
    expect((image as string[])[0]!.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("日志钩子记录出图进度（可观测，不静默）", async () => {
    const root = workDir();
    const { fetchImpl } = fakeArk();
    const log = vi.fn();
    const runtime = createPortraitRuntime({
      workDir: root, projectId: "VID-9999", apiKey: "k", model: "m", fetchImpl, log
    });
    await runtime.apiRender({ characterId: "住客", angle: "front_full" });
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/出图成功/);
  });
});

/**
 * T-2026-0923-0050 · 真机事故回归：角色定妆照"无角色档案"时会生成与设定无关的人物
 * （真机证据：要求"三十岁上下女性、深色缎面长裙"，产出的却是一名男性模特）。
 * 生产链路（studio-worker）打开 `requireCharacterDescription` 后必须 fail-closed。
 */
describe("角色定妆照：角色档案必填（生产链路 fail-closed）", () => {
  it("requireCharacterDescription=true 且无档案 → 拒绝出图，给出可行动提示", async () => {
    const { fetchImpl, calls } = fakeArk();
    const runtime = createPortraitRuntime({
      workDir: workDir(), projectId: "VID-9999", apiKey: "k", model: "m", fetchImpl,
      requireCharacterDescription: true
    });
    await expect(runtime.apiRender({
      portraitId: "平江路讲述人-front_full",
      characterName: "平江路讲述人",
      angle: "front_full",
      prompt: "【定妆照】平江路讲述人 — 全身正面"
    })).rejects.toThrow(/角色档案/);
    expect(calls).toHaveLength(0); // 不烧额度
  });

  it("requireCharacterDescription=true 且带 vendor 风格档案 → 出图成功，描述进入提示词", async () => {
    const { fetchImpl, calls } = fakeArk();
    const runtime = createPortraitRuntime({
      workDir: workDir(), projectId: "VID-9999", apiKey: "k", model: "m", fetchImpl,
      requireCharacterDescription: true
    });
    await runtime.apiRender({
      portraitId: "平江路讲述人-front_full",
      characterName: "平江路讲述人",
      angle: "front_full",
      prompt: [
        "【定妆照】平江路讲述人 — 全身正面",
        "角色档案：三十岁上下女性，深色缎面长裙，珍珠肩带，齐肩微卷发",
        "构图：全身，正面"
      ].join("\n")
    });
    const prompt = String(calls[0]!.body.prompt);
    expect(prompt).toContain("三十岁上下女性");
    expect(prompt).toContain("深色缎面长裙");
  });

  it("默认（不开启）保持 vendor 既有行为，但必须打印『无档案』告警，不静默", async () => {
    const { fetchImpl } = fakeArk();
    const log = vi.fn();
    const runtime = createPortraitRuntime({
      workDir: workDir(), projectId: "VID-9999", apiKey: "k", model: "m", fetchImpl, log
    });
    await runtime.apiRender({
      portraitId: "住客-front_full", characterName: "住客", angle: "front_full",
      prompt: "【定妆照】住客 — 正面全身"
    });
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/缺少角色档案描述/);
  });
});


describe("完整请求与产物绑定的定妆照缓存", () => {
  const task = { characterId: "演员甲", angle: "front_full", characterDescription: "三十岁女性，齐肩黑发，蓝色长裙", prompt: "女人穿蓝色长裙站立" };
  function configured(root = workDir(), extra: Partial<Parameters<typeof createPortraitRuntime>[0]> = {}) {
    const fake = fakeArk();
    return { root, ...fake, runtime: createPortraitRuntime({ workDir: root, projectId: "PROJECT", apiKey: "k", model: "m", retries: 0, fetchImpl: fake.fetchImpl, ...extra }) };
  }
  it("相同实际请求跨实例/重启复用，记录请求、来源、输出hash且快照不可改写内部索引", async () => {
    const first = configured(); const file = await first.runtime.apiRender(task);
    const second = configured(first.root); expect(await second.runtime.apiRender(task)).toBe(file); expect(second.calls).toHaveLength(0);
    const entry = second.runtime.snapshot().characters["演员甲"]!;
    expect(entry.receipts?.front).toMatchObject({ schemaVersion: "workloom.portrait-cache/v2", kind: "character", id: "演员甲", angle: "front", model: "m", output: { path: file, bytes: 4096 } });
    for (const value of [entry.receipts!.front!.requestHash, entry.receipts!.front!.sourceHash, entry.receipts!.front!.output.sha256]) expect(value).toMatch(/^[a-f0-9]{64}$/);
    entry.files.front = "/fake"; expect(second.runtime.snapshot().characters["演员甲"]!.files.front).toBe(file);
  });
  it("prompt/角色描述/模型/尺寸/endpoint变化分别失效，历史输出不被新请求覆盖", async () => {
    const initial = configured(); const original = await initial.runtime.apiRender(task); const oldBytes = readFileSync(original);
    for (const changed of [{ ...task, prompt: "女人穿红色长裙站立" }, { ...task, characterDescription: "四十岁女性，短发，红色外套" }]) expect(await initial.runtime.apiRender(changed)).not.toBe(original);
    for (const extra of [{ model: "m2" }, { size: "4K" }, { baseUrl: "https://other.example.invalid/v3" }]) {
      const next = configured(initial.root, extra); expect(await next.runtime.apiRender(task)).not.toBe(original); expect(next.calls).toHaveLength(1);
    }
    expect(readFileSync(original)).toEqual(oldBytes);
  });
  it("角色和商品同ID/角度不互用，清洗后相似ID也不覆盖", async () => {
    const { runtime, calls } = configured();
    const character = await runtime.apiRender({ ...task, characterId: "same" });
    const product = await runtime.apiRender({ productId: "same", view: "front_full", prompt: "产品正面" });
    expect(product).not.toBe(character); expect(product).toContain("/_products/same/"); expect(calls).toHaveLength(2);
    const a = await runtime.apiRender({ ...task, characterId: "甲/乙" });
    const b = await runtime.apiRender({ ...task, characterId: "甲:乙" }); expect(a).not.toBe(b);
  });
  it("参考图实际字节和顺序变化失效，发送字节与receipt一致", async () => {
    const root = workDir(); const a = writeRef(root, "a.png"); const b = writeRef(root, "b.png"); writeFileSync(b, Buffer.alloc(2048, 4));
    const first = configured(root, { characterAnchorImages: [a, b] }); const old = await first.runtime.apiRender(task);
    expect((first.calls[0]!.body.image as string[])[0]).toContain(readFileSync(a).toString("base64"));
    writeFileSync(a, Buffer.alloc(2048, 9)); expect(await first.runtime.apiRender(task)).not.toBe(old);
    const reverse = configured(root, { characterAnchorImages: [b, a] }); expect(await reverse.runtime.apiRender(task)).not.toBe(old); expect(reverse.calls).toHaveLength(1);
  });
  it("参考图symlink同字节改指向后重新核验；缺少显式参考图不静默丢弃", async () => {
    const root = workDir(); const a = writeRef(root, "a.png"); const b = writeRef(root, "b.png"); const link = join(root, "anchor.png"); symlinkSync(a, link);
    const next = configured(root, { characterAnchorImages: [link] }); await next.runtime.apiRender(task);
    unlinkSync(link); symlinkSync(b, link); await next.runtime.apiRender(task); expect(next.calls).toHaveLength(2);
    unlinkSync(link); await expect(next.runtime.apiRender(task)).rejects.toThrow(); expect(next.calls).toHaveLength(2);
  });
  it("输出被改字节/删除/替成symlink均不复用；旧无收据索引不能伪过", async () => {
    const next = configured(); let file = await next.runtime.apiRender(task);
    writeFileSync(file, Buffer.alloc(4096, 8)); await next.runtime.apiRender(task); expect(next.calls).toHaveLength(2);
    unlinkSync(file); await next.runtime.apiRender(task); expect(next.calls).toHaveLength(3);
    const external = writeRef(next.root, "outside.png"); unlinkSync(file); symlinkSync(external, file);
    await next.runtime.apiRender(task); expect(next.calls).toHaveLength(4); expect(readFileSync(external)).toEqual(Buffer.alloc(2048, 3));
    const index = JSON.parse(readFileSync(next.runtime.indexPath(), "utf8")); delete index.characters["演员甲"].receipts; writeFileSync(next.runtime.indexPath(), JSON.stringify(index));
    const restarted = configured(next.root); file = await restarted.runtime.apiRender(task); expect(restarted.calls).toHaveLength(1); expect(existsSync(file)).toBe(true);
  });
  it("20个相同请求和多个runtime只发送一次，异常后不遗留inflight或锁", async () => {
    const first = configured(); const second = configured(first.root, { fetchImpl: first.fetchImpl });
    const paths = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).runtime.apiRender(task)));
    expect(new Set(paths).size).toBe(1); expect(first.calls).toHaveLength(1); expect(second.runtime.snapshot().characters["演员甲"]?.files.front).toBe(paths[0]);
    const failing = fakeArk({ failStatus: 400 }); const broken = configured(workDir(), { fetchImpl: failing.fetchImpl, retries: 2 });
    await expect(Promise.all([broken.runtime.apiRender(task), broken.runtime.apiRender(task)])).rejects.toThrow(/HTTP 400/); expect(failing.calls).toHaveLength(1);
    expect(existsSync(join(broken.root, "characters/PROJECT/.portrait-cache.lock"))).toBe(false);
    const retry = configured(broken.root); expect(await retry.runtime.apiRender(task)).toContain("front.png"); expect(retry.calls).toHaveLength(1);
  });
  it("不同请求并发不会丢索引或覆盖返回给另一个调用者的文件", async () => {
    const next = configured();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => next.runtime.apiRender({ ...task, angle: ["front_full", "side_full", "three_quarter", "face_closeup", "back_full"][i]! })));
    expect(new Set(results).size).toBe(5); expect(next.calls).toHaveLength(5);
    const persisted = JSON.parse(readFileSync(next.runtime.indexPath(), "utf8")); expect(Object.keys(persisted.characters["演员甲"].files)).toHaveLength(5);
  });
  it("真实独立进程共享磁盘锁，第二进程读取已提交receipt而不重复出图", async () => {
    const root = workDir(); const count = join(root, "paid-calls.txt"); const modulePath = fileURLToPath(new URL("./portrait-runtime.ts", import.meta.url));
    const program = `import { createPortraitRuntime } from ${JSON.stringify(modulePath)}; import { appendFileSync } from 'node:fs'; const r=createPortraitRuntime({workDir:${JSON.stringify(root)},projectId:'PROJECT',apiKey:'k',model:'m',retries:0,fetchImpl:async(u)=>{if(String(u).includes('/images/generations')){appendFileSync(${JSON.stringify(count)},'1');await new Promise(r=>setTimeout(r,50));return new Response(JSON.stringify({data:[{url:'https://cdn.example.invalid/a'}]}));}return new Response(new Uint8Array(4096).fill(7));}}); console.log(await r.apiRender(${JSON.stringify(task)}));`;
    const execute = promisify(execFile);
    const results = await Promise.all(Array.from({ length: 3 }, () => execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { timeout: 30_000 })));
    expect(new Set(results.map((entry) => entry.stdout.trim())).size).toBe(1); expect(readFileSync(count, "utf8")).toBe("1");
  });
  it("输入在外调期间改变时不发布成功receipt", async () => {
    const root = workDir(); const ref = writeRef(root, "a.png"); const fake = fakeArk();
    const fetchImpl = (async (url, init) => { const response = await fake.fetchImpl(url, init); if (String(url).includes("/images/generations")) writeFileSync(ref, Buffer.alloc(2048, 5)); return response; }) as typeof fetch;
    const next = configured(root, { fetchImpl, characterAnchorImages: [ref] });
    await expect(next.runtime.apiRender(task)).rejects.toThrow("PORTRAIT_INPUT_CHANGED"); expect(Object.keys(next.runtime.snapshot().characters)).toHaveLength(0);
  });
  it("缓存命中也先验证角色描述要求，不绕过生产准入", async () => {
    const first = configured(); const vague = { characterId: "演员甲", angle: "front_full" }; await first.runtime.apiRender(vague);
    const strict = configured(first.root, { requireCharacterDescription: true }); await expect(strict.runtime.apiRender(vague)).rejects.toThrow(/角色档案/); expect(strict.calls).toHaveLength(0);
  });
  it("base优先使用当前输入，来源换图或改bytes后刷新且保留旧base", async () => {
    const root = workDir(); const ref = writeRef(root, "source.png"); const next = configured(root, { referenceImages: [ref] });
    const first = await next.runtime.processImage({}); expect(await next.runtime.processImage({})).toBe(first);
    writeFileSync(ref, Buffer.alloc(2048, 6)); const second = await next.runtime.processImage({ outputBaseImage: first }); expect(second).not.toBe(first);
    expect(readFileSync(first)).toEqual(Buffer.alloc(2048, 3)); expect(readFileSync(second)).toEqual(Buffer.alloc(2048, 6));
    writeFileSync(second, Buffer.alloc(2048, 8)); expect(await next.runtime.processImage({})).toBe(second); expect(readFileSync(second)).toEqual(Buffer.alloc(2048, 6));
  });
  it("非法路径/目录symlink/损坏索引/跨项目索引均在调用前失败", async () => {
    expect(() => configured(workDir(), { projectId: "../escape" })).toThrow("PORTRAIT_PATH_INVALID");
    const next = configured(); await expect(next.runtime.apiRender({ ...task, angle: "../../x" })).rejects.toThrow("PORTRAIT_ANGLE_INVALID"); expect(next.calls).toHaveLength(0);
    const external = workDir(); symlinkSync(external, join(next.root, "characters/PROJECT/演员甲")); await expect(next.runtime.apiRender(task)).rejects.toThrow("PORTRAIT_PATH_INVALID");
    expect(existsSync(join(external, "portraits"))).toBe(false); expect(next.calls).toHaveLength(0);
    writeFileSync(next.runtime.indexPath(), "invalid"); expect(() => configured(next.root)).toThrow();
    writeFileSync(next.runtime.indexPath(), JSON.stringify({ schemaVersion: "workloom.portrait-index/v1", projectId: "OTHER", characters: {}, products: {} })); expect(() => configured(next.root)).toThrow("PORTRAIT_INDEX_INVALID");
  });
  it("活进程锁超时不外调，不删除别人的锁；未知或symlink锁不冒险重发", async () => {
    const next = configured(workDir(), { timeoutMs: 30 }); const lock = join(next.root, "characters/PROJECT/.portrait-cache.lock");
    const owner = JSON.stringify({ pid: process.pid, token: "test-only-other-active-request" }); writeFileSync(lock, owner);
    await expect(next.runtime.apiRender(task)).rejects.toThrow("PORTRAIT_CACHE_BUSY"); expect(readFileSync(lock, "utf8")).toBe(owner); expect(next.calls).toHaveLength(0);
    writeFileSync(lock, "unverified"); await expect(next.runtime.apiRender(task)).rejects.toThrow("PORTRAIT_CACHE_LOCK_INVALID");
    unlinkSync(lock); const external = writeRef(next.root, "lock-target"); symlinkSync(external, lock);
    await expect(next.runtime.apiRender(task)).rejects.toThrow("PORTRAIT_CACHE_LOCK_INVALID"); expect(readFileSync(external)).toEqual(Buffer.alloc(2048, 3)); expect(next.calls).toHaveLength(0);
  });
  it("索引symlink拒绝复用或覆盖其外部目标", async () => {
    const next = configured(); await next.runtime.apiRender(task); const external = join(next.root, "other-index.json"); const content = readFileSync(next.runtime.indexPath());
    writeFileSync(external, content); unlinkSync(next.runtime.indexPath()); symlinkSync(external, next.runtime.indexPath());
    await expect(next.runtime.apiRender(task)).rejects.toThrow("PORTRAIT_INDEX_INVALID"); expect(readFileSync(external)).toEqual(content); expect(next.calls).toHaveLength(1);
  });
  it("坏响应不自动再次收费；短下载不发布成功收据且释放锁", async () => {
    for (const body of ["invalid-json", JSON.stringify({ data: [] })]) {
      let calls = 0; const next = configured(workDir(), { retries: 2, fetchImpl: (async () => { calls++; return new Response(body); }) as typeof fetch });
      await expect(next.runtime.apiRender(task)).rejects.toThrow(); expect(calls).toBe(1); expect(Object.keys(next.runtime.snapshot().characters)).toHaveLength(0);
    }
    const fake = fakeArk(); const next = configured(workDir(), { fetchImpl: (async (url, init) => String(url).includes("/images/generations") ? fake.fetchImpl(url, init) : new Response(new Uint8Array(12))) as typeof fetch });
    await expect(next.runtime.apiRender(task)).rejects.toThrow(/下载内容过小/); expect(Object.keys(next.runtime.snapshot().characters)).toHaveLength(0); expect(existsSync(join(next.root, "characters/PROJECT/.portrait-cache.lock"))).toBe(false);
  });
  it("收据请求或输出hash被改后不命中；特殊JS键仍按独立角色持久化", async () => {
    const next = configured(); await next.runtime.apiRender(task);
    const index = JSON.parse(readFileSync(next.runtime.indexPath(), "utf8")); index.characters["演员甲"].receipts.front.requestHash = "0".repeat(64); writeFileSync(next.runtime.indexPath(), JSON.stringify(index));
    await next.runtime.apiRender(task); expect(next.calls).toHaveLength(2);
    const file = await next.runtime.apiRender({ ...task, characterId: "__proto__" }); const entries = Object.values(next.runtime.snapshot().characters);
    expect(entries.find(entry => entry.id === "__proto__")?.files.front).toBe(file); expect(await next.runtime.apiRender({ ...task, characterId: "__proto__" })).toBe(file); expect(next.calls).toHaveLength(3);
  });
  it("原始任务在外调中被修改时拒绝记成功", async () => {
    const changing = { ...task }; const fake = fakeArk();
    const next = configured(workDir(), { fetchImpl: (async (url, init) => { const response = await fake.fetchImpl(url, init); if (String(url).includes("/images/generations")) changing.prompt = "调用期间更改"; return response; }) as typeof fetch });
    await expect(next.runtime.apiRender(changing)).rejects.toThrow("PORTRAIT_INPUT_CHANGED"); expect(Object.keys(next.runtime.snapshot().characters)).toHaveLength(0);
  });
});
