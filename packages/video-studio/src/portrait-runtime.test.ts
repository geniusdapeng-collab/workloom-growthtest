import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

function workDir(): string {
  return mkdtempSync(join(tmpdir(), "wl-portrait-"));
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

    expect(first).toContain("/char_001/portraits/char_001-front.png");
    expect(second).toContain("/char_002/portraits/char_002-front.png");
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
