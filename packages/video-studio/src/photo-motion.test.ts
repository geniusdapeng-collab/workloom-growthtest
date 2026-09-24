import { describe, expect, it } from "vitest";
import { PHOTO_MOTION_PRESETS, buildPhotoMotion, photoMotionCommand } from "./photo-motion.js";

describe("真实照片 → 动态镜头段（photo-motion）", () => {
  it("三种缓动都是解析式、无随机：同参数两次结果完全一致", () => {
    const a = buildPhotoMotion({ preset: "whip-in", durationSec: 5, width: 1080, height: 1920 });
    const b = buildPhotoMotion({ preset: "whip-in", durationSec: 5, width: 1080, height: 1920 });
    expect(a.filter).toBe(b.filter);
    expect(a.frames).toBe(150);
  });

  it("横图进 9:16：先按覆盖放大到 2× 目标再裁切，焦点可指定", () => {
    const plan = buildPhotoMotion({ preset: "push-in-hard", durationSec: 5, width: 1080, height: 1920, focus: { x: 0.4, y: 0.45 } });
    expect(plan.filter).toContain("scale=2160:3840:force_original_aspect_ratio=increase");
    expect(plan.filter).toContain("crop=2160:3840:(iw-2160)*0.4:(ih-3840)*0.45");
    expect(plan.filter).toContain("zoompan=");
    expect(plan.filter).toContain("s=1080x1920");
    expect(plan.filter).toContain("format=yuv420p");
    expect(plan.filter).toContain("setsar=1");
  });

  it("六个预设有各自的运动方向与缓动，且推/拉的起止相反", () => {
    const push = PHOTO_MOTION_PRESETS["push-in-hard"];
    const pull = PHOTO_MOTION_PRESETS["pull-out-hard"];
    expect(push.zoom[1]).toBeGreaterThan(push.zoom[0]);
    expect(pull.zoom[0]).toBeGreaterThan(pull.zoom[1]);
    expect(PHOTO_MOTION_PRESETS["pan-left-fast"].x[0]).toBeGreaterThan(PHOTO_MOTION_PRESETS["pan-left-fast"].x[1]);
    expect(PHOTO_MOTION_PRESETS["pan-right-fast"].x[1]).toBeGreaterThan(PHOTO_MOTION_PRESETS["pan-right-fast"].x[0]);
    expect(PHOTO_MOTION_PRESETS["tilt-up-fast"].y[0]).toBeGreaterThan(PHOTO_MOTION_PRESETS["tilt-up-fast"].y[1]);
    expect(PHOTO_MOTION_PRESETS["whip-in"].ease).toBe("whip");
  });

  it("甩镜缓动在 10% 处连续（两段表达式在 t=0.1 都等于 0.55）", () => {
    const plan = buildPhotoMotion({ preset: "whip-in", durationSec: 4, width: 1080, height: 1920 });
    expect(plan.filter).toContain("if(lt((on/120),0.1),5.5*(on/120),0.55+0.45*(1-pow(1-((on/120)-0.1)/0.9,3)))");
  });

  it("命令补齐静音音轨（避免拼接阶段音轨不一致）并限定时长/帧率", () => {
    const cmd = photoMotionCommand({ preset: "pan-right-fast", durationSec: 5, fps: 30, width: 1080, height: 1920, input: "/in.jpg", output: "/out.mp4" });
    expect(cmd).toContain("anullsrc=channel_layout=stereo:sample_rate=48000");
    expect(cmd).toContain("-loop");
    expect(cmd.join(" ")).toContain("d=150"); // 5s × 30fps 的 zoompan 帧数
    expect(cmd.join(" ")).toContain("-t 5");
    expect(cmd.join(" ")).toContain("-r 30");
    expect(cmd.at(-1)).toBe("/out.mp4");
  });

  it("未知预设直接抛错（不静默回退成某种运镜）", () => {
    expect(() => buildPhotoMotion({ preset: "spin" as never, durationSec: 5, width: 1080, height: 1920 })).toThrow(/未知的 photo-motion 预设/);
  });
});
