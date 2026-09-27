/**
 * media 纯逻辑契约（T-2026-0926-0007/0009/0010）：不依赖数据库与外部二进制。
 *
 * 覆盖：
 *  ① 上传凭证的签名覆盖与防篡改（含"改工作区/改文件名/改上限"三类越权尝试）；
 *  ② 设备密钥派生与请求签名的确定性（同一输入同签名、换 body 换签名）；
 *  ③ dossier 摘要只做忠实映射（缺字段留 null，绝不补编）；
 *  ④ 媒体仓路径口径（上传件与生成件分仓、扩展名兜底）；
 *  ⑤ 交付包目录名的路径安全判据；
 *  ⑥ 重剪与抽帧的显式失败（缺输入即报错，不静默成功）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scopedDeliveryRoot } from "../delivery-trust.js";

process.env.MEDIA_SIGNING_SECRET ??= "test-media-signing-secret";

const TMP = mkdtempSync(join(tmpdir(), "media-unit-"));

const { safeExtOf, signUploadTicket, verifyUploadTicket, uploadRelPath } = await import("./upload.js");
const { bodyHash, deviceKeyFor, deviceSignature } = await import("./sync.js");
const { summarizeDossier } = await import("./products.js");
const { embeddingTextOf, semanticEnabled } = await import("./embed.js");
const { mediaRelPathFor } = await import("./register-local.js");
const { assertSafePackageName } = await import("./ingest-delivery.js");
const { concatNormalize, extractThumbnail } = await import("./ffmpeg.js");

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("上传凭证（三步制的第①步）", () => {
  it("签发 → 校验通过，且载荷字段参与签名", () => {
    const ticket = signUploadTicket({ workspaceId: "ws-a", filename: "样片 01.MP4", maxBytes: 1024 }, { now: 1_700_000_000_000 });
    const verdict = verifyUploadTicket(ticket.token, { now: 1_700_000_000_000 + 1000 });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.workspaceId).toBe("ws-a");
      expect(verdict.filename).toBe("样片 01.MP4");
      expect(verdict.maxBytes).toBe(1024);
    }
  });

  it("过期即拒（TTL 之外）", () => {
    const ticket = signUploadTicket({ workspaceId: "ws-a", filename: "a.mp4", maxBytes: 10 }, { now: 1_700_000_000_000, ttlSec: 60 });
    const verdict = verifyUploadTicket(ticket.token, { now: 1_700_000_000_000 + 61_000 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("UPLOAD_TICKET_EXPIRED");
  });

  it("篡改载荷（改 workspace / 文件名 / 上限）必然签名不匹配", () => {
    const ticket = signUploadTicket({ workspaceId: "ws-a", filename: "a.mp4", maxBytes: 10 });
    const [exp, encoded, sig] = ticket.token.split(".");
    const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
    for (const mutated of [
      { ...payload, workspaceId: "ws-b" },
      { ...payload, filename: "b.mp4" },
      { ...payload, maxBytes: 1_000_000 },
    ]) {
      const forged = `${exp}.${Buffer.from(JSON.stringify(mutated), "utf8").toString("base64url")}.${sig}`;
      const verdict = verifyUploadTicket(forged);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("UPLOAD_TICKET_BAD_SIGNATURE");
    }
  });

  it("格式非法即拒（不做任何兜底签名）", () => {
    expect(verifyUploadTicket("").ok).toBe(false);
    expect(verifyUploadTicket("abc.def").ok).toBe(false);
    expect(verifyUploadTicket("123.@@@@.sig").ok).toBe(false);
  });

  it("扩展名白名单化 + 上传件落 upload/ 分仓", () => {
    expect(safeExtOf("片段.MP4")).toBe(".mp4");
    expect(safeExtOf("no-extension")).toBe("");
    expect(safeExtOf("evil.$%^")).toBe("");
    expect(safeExtOf("a.tar.gz")).toBe(".gz");
    expect(uploadRelPath("ws-a", "f".repeat(64), "clip.webm")).toBe(`upload/ws-a/${"f".repeat(64)}.webm`);
  });
});

describe("设备签名（云端同步）", () => {
  it("设备密钥由主密钥确定性派生；签名覆盖 method/path/timestamp/body", () => {
    const key = deviceKeyFor("SD-1", { MEDIA_SYNC_MASTER_SECRET: "master" });
    expect(key).toBe(deviceKeyFor("SD-1", { MEDIA_SYNC_MASTER_SECRET: "master" }));
    expect(key).not.toBe(deviceKeyFor("SD-2", { MEDIA_SYNC_MASTER_SECRET: "master" }));
    const base = { method: "POST", path: "/sync/media/push", timestamp: "1700000000000", bodySha256: bodyHash("{}") };
    const signature = deviceSignature(base, key);
    expect(deviceSignature({ ...base }, key)).toBe(signature);
    expect(deviceSignature({ ...base, method: "GET" }, key)).not.toBe(signature);
    expect(deviceSignature({ ...base, path: "/sync/media/pull" }, key)).not.toBe(signature);
    expect(deviceSignature({ ...base, bodySha256: bodyHash('{"a":1}') }, key)).not.toBe(signature);
    expect(deviceSignature({ ...base, timestamp: "1700000000001" }, key)).not.toBe(signature);
  });

  it("缺密钥时拒绝派生（fail-closed，不用默认值兜底）", () => {
    expect(() => deviceKeyFor("SD-1", {})).toThrow(/缺少/);
  });
});

describe("商品档案摘要（忠实映射）", () => {
  it("读得到的字段原样映射，读不到的一律留 null / 空数组", () => {
    const summary = summarizeDossier({
      product_id: "PRD-1",
      identity: { name: "折叠电煮锅", brand: "山野", category: "厨具", price_band: "100-200" },
      selling_points: ["一键折叠", { claim: "3 分钟出餐" }],
      confidence: 0.82,
      provenance: [{ url: "a" }, { url: "b" }],
      gaps: ["缺竞品"],
      visual_assets: { needs_more_reference: false },
    });
    expect(summary.productId).toBe("PRD-1");
    expect(summary.name).toBe("折叠电煮锅");
    expect(summary.brand).toBe("山野");
    expect(summary.sellingPoints).toEqual(["一键折叠", "3 分钟出餐"]);
    expect(summary.confidence).toBe(0.82);
    expect(summary.evidenceCount).toBe(2);
    expect(summary.gaps).toBe(1);
  });

  it("空档案不编数据（不允许默认品牌/推测类目这类补编）", () => {
    const summary = summarizeDossier({ product_id: "PRD-2" });
    expect(summary.brand).toBeNull();
    expect(summary.category).toBeNull();
    expect(summary.confidence).toBeNull();
    expect(summary.sellingPoints).toEqual([]);
  });
});

describe("向量文本与开关", () => {
  it("title/prompt/tags 拼接，空段不进文本", () => {
    expect(embeddingTextOf({ title: "镜头 A", prompt: "实验室里讲解", tags: ["口播", "科普"] }))
      .toBe("镜头 A\n实验室里讲解\n口播、科普");
    expect(embeddingTextOf({ title: null, prompt: null, tags: [] })).toBe("");
  });

  it("语义检索默认关闭（行为与 P1 一致）", () => {
    expect(semanticEnabled({})).toBe(false);
    expect(semanticEnabled({ MEDIA_SEMANTIC_ENABLED: "1" })).toBe(true);
  });
});

describe("媒体仓路径与交付包目录安全", () => {
  it("路径围栏：resolveInside/assertInside 拒绝 `..` 与仓外绝对路径，safeSegment 只收单段", async () => {
    const { assertInside, resolveInside, safeSegment } = await import("./paths.js");
    const root = join(TMP, "confine");
    mkdirSync(join(root, "ws-a"), { recursive: true });
    expect(resolveInside(root, "ws-a/clip.mp4")).toBe(join(root, "ws-a/clip.mp4"));
    for (const bad of ["../../etc/passwd", "ws-a/../../../etc/passwd", "/etc/passwd"]) {
      expect(() => resolveInside(root, bad), `越界输入必须被拒：${bad}`).toThrow(/越界|非法/);
    }
    expect(assertInside(root, join(root, "ws-a"))).toBe(join(root, "ws-a"));
    expect(safeSegment("PRD-1")).toBe("PRD-1");
    for (const bad of ["../../etc", "a/b", ".hidden", ""]) {
      expect(() => safeSegment(bad), `非法标识必须被拒：${bad}`).toThrow(/非法/);
    }
  });

  it("上传件进 upload/、生成件进 video|image（扩展名兜底）", () => {
    expect(mediaRelPathFor("upload_video", "ws-a", "a".repeat(64), "/tmp/x")).toBe(`upload/ws-a/${"a".repeat(64)}.mp4`);
    expect(mediaRelPathFor("clip", "ws-a", "b".repeat(64), "/tmp/x.mov")).toBe(`video/ws-a/${"b".repeat(64)}.mov`);
    expect(mediaRelPathFor("portrait", "ws-a", "c".repeat(64), "/tmp/no-ext")).toBe(`image/ws-a/${"c".repeat(64)}.png`);
  });

  it("交付包目录名只接受目录名（拒绝穿越与绝对路径）", () => {
    const root = join(TMP, "delivery");
    const scope = { tenantId: "tenant-media", workspaceId: "ws-a" };
    const pkg = join(scopedDeliveryRoot(root, scope), "pkg-1");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "delivery-manifest.json"), JSON.stringify({ scope, projectId: "P1" }));
    expect(assertSafePackageName("pkg-1", scope, { WORKLOOM_DELIVERY_DIR: root })).toBe(pkg);
    for (const bad of ["../etc", "/etc/passwd", ".hidden", "a/b", ""]) {
      expect(() => assertSafePackageName(bad, scope, { WORKLOOM_DELIVERY_DIR: root })).toThrow();
    }
  });
});

describe("本地媒体工具的显式失败", () => {
  it("抽帧：源文件不存在 → ok:false（不假装成功）", async () => {
    const result = await extractThumbnail(join(TMP, "nope.mp4"), join(TMP, "out.jpg"));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/不存在/);
  });

  it("重剪：少于 2 段或素材缺失 → 抛错", async () => {
    await expect(concatNormalize([join(TMP, "only-one.mp4")], join(TMP, "out.mp4"))).rejects.toThrow(/至少需要 2 段/);
    await expect(concatNormalize([join(TMP, "a.mp4"), join(TMP, "b.mp4")], join(TMP, "out.mp4"))).rejects.toThrow(/不在本地媒体仓/);
  });
});
