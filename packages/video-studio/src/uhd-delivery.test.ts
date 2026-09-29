import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { publishUhdDelivery } from "./uhd-delivery.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uhd-publish-")); temporary.push(dir);
  const stagingDir = join(dir, ".uhd-staging", "run-new"), publicRoot = join(dir, "uhd");
  const previous = join(publicRoot, "releases", "run-old");
  const releaseId = "run-new", releaseDir = join(publicRoot, "releases", releaseId);
  mkdirSync(stagingDir, { recursive: true }); mkdirSync(previous, { recursive: true });
  writeFileSync(join(previous, "master.mp4"), "last approved release");
  writeFileSync(join(publicRoot, "current.json"), JSON.stringify({ releaseId: "run-old", releaseDir: previous }));
  writeFileSync(join(publicRoot, "legacy-flat.mp4"), "existing legacy public file");
  const contents: Record<string, string> = {
    "master.mp4": "new reviewed master", "variant.mp4": "new measured variant",
    "cover.png": "approved cover", "softsub.mp4": "approved soft subtitle", "subtitles/zh.srt": "approved sidecar",
  };
  for (const [name, value] of Object.entries(contents)) {
    mkdirSync(dirname(join(stagingDir, name)), { recursive: true });
    writeFileSync(join(stagingDir, name), value);
  }
  const manifestName = "delivery-manifest.json";
  const assetHashes = Object.entries(contents).map(([name, value]) => ({ path: join(releaseDir, name), sha256: sha(value) }));
  writeFileSync(join(stagingDir, manifestName), JSON.stringify({
    deliverable: { path: join(releaseDir, "master.mp4"), sha256: sha(contents["master.mp4"]!) },
    variants: [{ path: join(releaseDir, "variant.mp4"), sha256: sha(contents["variant.mp4"]!) }],
    cover: { path: join(releaseDir, "cover.png") },
    subtitles: { sidecarDir: join(releaseDir, "subtitles"), softsub: join(releaseDir, "softsub.mp4") },
    assets: assetHashes,
  }));
  return { stagingDir, publicRoot, releaseId, releaseDir, manifestName,
    assets: [...Object.keys(contents), manifestName] };
}

describe("UHD immutable release publication", () => {
  it("闸门未通过时旧 current、cover/softsub 和正式版本均不变", async () => {
    const input = fixture();
    const pointer = readFileSync(join(input.publicRoot, "current.json"), "utf8");
    await expect(publishUhdDelivery({ ...input, approved: false })).rejects.toThrow("GATE_NOT_APPROVED");
    expect(readFileSync(join(input.publicRoot, "current.json"), "utf8")).toBe(pointer);
    expect(existsSync(input.releaseDir)).toBe(false);
    expect(existsSync(join(input.publicRoot, "cover.png"))).toBe(false);
    expect(existsSync(join(input.publicRoot, "softsub.mp4"))).toBe(false);
  });

  it("全闸通过后新增不可变版本，并单次替换 current 指针", async () => {
    const input = fixture();
    const result = await publishUhdDelivery({ ...input, approved: true });
    expect(result.files).toBe(6);
    expect(JSON.parse(readFileSync(result.currentFile, "utf8")).releaseDir).toBe(input.releaseDir);
    for (const name of ["master.mp4", "variant.mp4", "cover.png", "softsub.mp4", "subtitles/zh.srt", input.manifestName]) {
      expect(existsSync(join(input.releaseDir, name))).toBe(true);
    }
    expect(readFileSync(join(input.publicRoot, "releases", "run-old", "master.mp4"), "utf8")).toBe("last approved release");
    expect(readFileSync(join(input.publicRoot, "legacy-flat.mp4"), "utf8")).toBe("existing legacy public file");
  });

  it("主封面、软字幕或字幕的摘要被篡改时旧 current 保持原样", async () => {
    for (const name of ["cover.png", "softsub.mp4", "subtitles/zh.srt"]) {
      const input = fixture();
      const pointer = readFileSync(join(input.publicRoot, "current.json"), "utf8");
      writeFileSync(join(input.stagingDir, name), "tampered bytes");
      await expect(publishUhdDelivery({ ...input, approved: true })).rejects.toThrow("MANIFEST_DIGEST_MISMATCH");
      expect(readFileSync(join(input.publicRoot, "current.json"), "utf8")).toBe(pointer);
      expect(existsSync(input.releaseDir)).toBe(false);
    }
  });

  it("新版本目录 rename 成功但 current 指针 rename 失败时旧 current 无空窗", async () => {
    const input = fixture();
    const pointer = readFileSync(join(input.publicRoot, "current.json"), "utf8");
    let calls = 0;
    const failPointerMove = ((from: string, to: string) => {
      calls += 1;
      if (calls === 2) throw new Error("injected pointer rename failure");
      renameSync(from, to);
    }) as typeof renameSync;
    await expect(publishUhdDelivery({ ...input, approved: true }, failPointerMove)).rejects.toThrow("injected pointer rename failure");
    expect(readFileSync(join(input.publicRoot, "current.json"), "utf8")).toBe(pointer);
    expect(readFileSync(join(input.publicRoot, "releases", "run-old", "master.mp4"), "utf8")).toBe("last approved release");
    expect(existsSync(input.releaseDir)).toBe(false);
  });

  it("相对路径越界在复制前拒绝", async () => {
    const input = fixture();
    await expect(publishUhdDelivery({ ...input, assets: [...input.assets, "../escape"], approved: true })).rejects.toThrow("UNSAFE_PATH");
    expect(JSON.parse(readFileSync(join(input.publicRoot, "current.json"), "utf8")).releaseId).toBe("run-old");
  });
});
