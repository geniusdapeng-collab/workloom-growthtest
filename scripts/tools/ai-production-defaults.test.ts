import { describe, expect, it } from "vitest";
import {
  AI_PRODUCTION_DEFAULT_STAGES,
  AI_PRODUCTION_DEFAULT_SUBTITLE_MODE,
  resolveAiProductionDanmakuEnabled,
} from "./lib/ai-production-defaults.js";

describe("普通 AI 视频全链缺省契约", () => {
  it("默认单母版：不隐式运行多风格 deliver", () => {
    expect(AI_PRODUCTION_DEFAULT_STAGES).toContain("compose");
    expect(AI_PRODUCTION_DEFAULT_STAGES).toContain("color");
    expect(AI_PRODUCTION_DEFAULT_STAGES).toContain("subtitle");
    expect(AI_PRODUCTION_DEFAULT_STAGES).toContain("bgm");
    expect(AI_PRODUCTION_DEFAULT_STAGES).toContain("cover");
    expect(AI_PRODUCTION_DEFAULT_STAGES).toContain("master");
    expect(AI_PRODUCTION_DEFAULT_STAGES).not.toContain("deliver");
    expect(AI_PRODUCTION_DEFAULT_STAGES).not.toContain("danmaku");
  });

  it("默认烧录台词", () => {
    expect(AI_PRODUCTION_DEFAULT_SUBTITLE_MODE).toBe("burn");
  });

  it("弹幕只在显式提供条目或 auto 开关时启用", () => {
    expect(resolveAiProductionDanmakuEnabled({})).toBe(false);
    expect(resolveAiProductionDanmakuEnabled({ autoDanmaku: false })).toBe(false);
    expect(resolveAiProductionDanmakuEnabled({ autoDanmaku: true })).toBe(true);
    expect(resolveAiProductionDanmakuEnabled({ danmakuFile: "/tmp/danmaku.json" })).toBe(true);
    expect(resolveAiProductionDanmakuEnabled({ danmakuFile: "/tmp/danmaku.json", noDanmaku: true })).toBe(false);
  });
});
