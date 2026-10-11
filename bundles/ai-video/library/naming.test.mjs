import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArtifactName, displayNamesForDelivery, resolutionBadge, sanitizeNamePart } from "./naming.mjs";

test("分辨率徽标按短边实测换算", () => {
  assert.equal(resolutionBadge({ width: 3840, height: 2160 }), "4K");
  assert.equal(resolutionBadge({ width: 2160, height: 3840 }), "4K");
  assert.equal(resolutionBadge({ width: 1920, height: 1080 }), "1080P");
  assert.equal(resolutionBadge({ width: 0, height: 0 }), "未知分辨率");
});

test("中文名 = 片名·版本名·核心特点·分辨率·版本号", () => {
  assert.equal(buildArtifactName({
    title: "别人挤景区，我回村摘苹果",
    variantName: "暖调故事版",
    feature: "带字幕",
    resolution: { width: 3840, height: 2160 },
    version: "V10",
    ext: ".mp4",
  }), "别人挤景区我回村摘苹果·暖调故事版·带字幕·4K·V10.mp4");
});

test("预览件标真实分辨率，清洗标点与空白", () => {
  assert.equal(buildArtifactName({
    title: "别人挤景区，我回村摘苹果", variantName: "暖调故事版", feature: "带字幕",
    resolution: { width: 1920, height: 1080 }, version: "V10", preview: true, ext: "mp4",
  }), "别人挤景区我回村摘苹果·暖调故事版·带字幕·1080P·预览·V10.mp4");
  assert.equal(sanitizeNamePart("a/b:c d·e"), "abcde");
});

test("交付名集合含母版与各变体四形态", () => {
  const names = displayNamesForDelivery({
    title: "别人挤景区我回村摘苹果", version: "V10", resolution: { width: 3840, height: 2160 },
    variants: [{ id: "warm-story" }, { id: "segmented-story" }],
  });
  assert.match(names.master, /干净母版·4K·V10\.mp4$/u);
  assert.match(names.variants[1].burned, /分段调色版·带字幕·4K·V10\.mp4$/u);
  assert.match(names.variants[0].cover, /暖调故事版·封面·4K·V10\.png$/u);
});
