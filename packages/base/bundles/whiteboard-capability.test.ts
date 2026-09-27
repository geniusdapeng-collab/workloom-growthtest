/**
 * 手绘白板解说引擎能力（vendored 引擎 / 目录登记 / 开关 / 迁移 / 编排面）静态回归。
 *
 * 为什么单独一组：白板这条链路的失败模式大多是**静默**的——
 *   · 上游脚本被误改 → 笔迹/遮罩行为变了，但"跑得通"；
 *   · 本地补丁丢了（跨平台字体、包围盒落墨）→ 在 macOS/Linux 上直接崩，或渲染慢 5 倍；
 *   · `vendor/srt-whiteboard/.venv` 被误提交 → 300MB 二进制垃圾进仓；
 *   · 目录里漏登记 `whiteboard-stream` → UI 里引擎凭空消失（用户以为没这能力）；
 *   · 迁移号与既有文件撞车 / `kind` 约束没扩展 → 建片或入库直接 500；
 *   · 上游执笔手素材（笔杆带第三方渠道标识）被用进对外成片。
 * 这些都能在磁盘上静态验出来，因此本组不触 DB、不跑 python、不出片。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundlesRoot } from "./assembly.js";

const ROOT = bundlesRoot();
const REPO_ROOT = dirname(ROOT);
const ENGINE = join(REPO_ROOT, "vendor/srt-whiteboard");
const WHITEBOARD_SRC = join(REPO_ROOT, "apps/server/src/video/whiteboard");

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("vendored 引擎：引脚、补丁与许可", () => {
  it("上游脚本与素材随仓齐备（缺一即引擎不可用）", () => {
    for (const rel of [
      "scripts/parse_srt.py",
      "scripts/render_stream_whiteboard.py",
      "scripts/stream_render.py",
      "scripts/merge_scenes.py",
      "scripts/render_annotation_preview.py",
      "scripts/prepare_env.py",
      "assets/drawing-hand.png",
      "assets/preview.html",
      "examples/scene-01-monkey-mountain-banana.png",
      "examples/scene-01-monkey-mountain-banana.annotation.json",
      "LICENSE",
      "PINNED.md",
      "VENDOR.md",
      "requirements.txt",
    ]) {
      expect(existsSync(join(ENGINE, rel)), `缺文件：vendor/srt-whiteboard/${rel}`).toBe(true);
    }
  });

  it("MIT 许可与上游作者署名保留（可商用的前提）", () => {
    const license = readFileSync(join(ENGINE, "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("江哥是老登啊");
  });

  it("PINNED 记录上游 commit 与五处本地补丁（升级时按此重放）", () => {
    const pinned = readFileSync(join(ENGINE, "PINNED.md"), "utf8");
    expect(pinned).toContain("696a7243c0e6ffb6827676e539c2ca5ebae2bf6b");
    expect(pinned).toContain("render_annotation_preview.py");
    expect(pinned).toContain("prepare_env.py");
    expect(pinned).toContain("_reveal_ink_segment");
    expect(pinned).toContain("INTER_CUBIC");
  });

  it("本地补丁在位：跨平台字体 + 落墨包围盒 + UHD 放大插值 + 解释器版本闸", () => {
    const preview = readFileSync(join(ENGINE, "scripts/render_annotation_preview.py"), "utf8");
    // 字体必须走"候选表 + 逐平台探测"，而不是单一硬编码路径（上游只在 Windows 可用）
    expect(preview).toContain("FONT_CANDIDATES");
    expect(preview).toContain("PingFang.ttc");
    expect(preview).toContain("WHITEBOARD_PREVIEW_FONT");
    expect(preview).toContain("resolve_font");

    const renderer = readFileSync(join(ENGINE, "scripts/render_stream_whiteboard.py"), "utf8");
    // 包围盒落墨：不得再出现"每次调用新建整幅掩码"
    expect(renderer).not.toContain("seg = np.zeros((self.out_h, self.out_w), dtype=np.uint8)");
    expect(renderer).toContain("pad = thick + 1");
    expect(renderer).toContain("cfg.cap_long_edge == 3840 and scale > 1 else cv2.INTER_AREA");

    const prepare = readFileSync(join(ENGINE, "scripts/prepare_env.py"), "utf8");
    expect(prepare).toContain("MIN_PYTHON");
    expect(prepare).toContain("WHITEBOARD_PYPI_INDEX");
  });

  it("venv 与渲染产物不入库（.gitignore 双保险）", () => {
    const gitignore = read(".gitignore");
    expect(gitignore).toContain("vendor/srt-whiteboard/.venv/");
    expect(gitignore).toContain("var/whiteboard-jobs/");
  });

  it("运行时依赖闭包已登记（oss-inventory 采集面）", () => {
    const req = readFileSync(join(ENGINE, "requirements.txt"), "utf8");
    for (const pkg of ["opencv-python", "numpy", "av", "Pillow"]) {
      expect(req, `requirements.txt 缺 ${pkg}`).toContain(pkg);
    }
    const registry = JSON.parse(read("oss-components.json")) as {
      components: Array<{ repo?: string; license?: string; channel?: string }>;
    };
    const entry = registry.components.find((c) => c.repo?.includes("srt-whiteboard-animation"));
    expect(entry, "oss-components.json 未登记 srt-whiteboard-animation").toBeTruthy();
    expect(entry?.license).toBe("MIT");
    expect(entry?.channel).toBe("vendor");
  });
});

describe("接线面：目录 / 开关 / 迁移 / 编排", () => {
  it("媒体目录登记 whiteboard-stream（provider=whiteboard-local，零报价）", () => {
    const catalog = JSON.parse(read("bundles/ai-video/library/media-catalog/media-catalog.json")) as {
      models: Array<{ id: string; provider: string; kind: string; availability: string; pricing: { usd: number | null } | null }>;
    };
    const model = catalog.models.find((m) => m.id === "whiteboard-stream");
    expect(model).toBeTruthy();
    expect(model!.provider).toBe("whiteboard-local");
    expect(model!.kind).toBe("video");
    expect(model!.availability).toBe("wired");
    // 本地 CPU 渲染：单价必须显式是 0，而不是"未核价"——否则成本闸会把免费算力当未知价
    expect(model!.pricing?.usd).toBe(0);
  });

  it("provider 装配：开关型判定（非空即配置不适用）+ 单例键覆盖白板变量", () => {
    const providers = read("apps/server/src/video/gen/providers.ts");
    expect(providers).toContain("whiteboardEngineReady(env)");
    expect(providers).toContain('pool.set("whiteboard-local"');
    expect(providers).toContain("env.WHITEBOARD_ENABLED");

    const catalog = read("apps/server/src/video/gen/catalog.ts");
    expect(catalog).toContain('"whiteboard-local": ["WHITEBOARD_ENABLED"]');
    expect(catalog).toContain('provider === "whiteboard-local"');
  });

  it("白板路由已挂进 videoRouter", () => {
    const router = read("apps/server/src/video/router.ts");
    expect(router).toContain('import { whiteboardRouter } from "./whiteboard/router.js"');
    expect(router).toContain("whiteboard: whiteboardRouter");
  });

  it("本地产物入库：file:// 与裸绝对路径都被接受（白板是本地渲染）", () => {
    const ingest = read("apps/server/src/video/gen/ingest.ts");
    expect(ingest).toContain("storeLocalFile");
    expect(ingest).toContain("/^file:\\/\\//i.test(uri)");
    expect(ingest).toContain("uri.startsWith(\"/\")");
  });

  it("白板迁移：kind/pipeline_kind 扩展 + 两张表 + 幂等 RLS", () => {
    /**
     * 迁移**按文件名后缀发现**，不写死编号：舰队里各仓迁移序列本就不同步
     * （本仓 0042、growthtest 0043、growthmatrix 0053），写死编号会让能力测试在移植仓直接红。
     */
    const migrationsDir = join(REPO_ROOT, "packages/db/migrations");
    const file = readdirSync(migrationsDir).find((name) => name.endsWith("_whiteboard.sql"));
    expect(file, "找不到 *_whiteboard.sql 迁移").toBeTruthy();
    const sql = readFileSync(join(migrationsDir, file!), "utf8");
    expect(sql).toContain("video_projects_kind_check");
    expect(sql).toContain("'explainer'");
    expect(sql).toContain("video_assets_pipeline_kind_check");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS whiteboard_films");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS whiteboard_scenes");
    expect(sql).toContain("DROP POLICY IF EXISTS");
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON whiteboard_films, whiteboard_scenes TO workloom_app");
    /**
     * 迁移号不得与既有文件撞车（这是接入时的真实事故：规格书写 0041，而 0041 已被占用）。
     * 断言「编号唯一」而不是「某个具体文件存在」——各仓迁移序列不同步
     * （本仓 0042 / growthtest 0043 / growthmatrix 0053），写死文件名会让能力测试在移植仓误红。
     */
    const prefix = file!.match(/^(\d{4})_/)![1];
    const sameNumber = readdirSync(migrationsDir).filter((name) => name.startsWith(`${prefix}_`));
    expect(sameNumber, `迁移号 ${prefix} 撞车：${sameNumber.join("、")}`).toEqual([file]);
  });

  it("编排面齐备：七个环节 + 两个长任务观察面 + 单幕返修", () => {
    const router = read("apps/server/src/video/whiteboard/router.ts");
    for (const procedure of [
      "health", "status", "create", "narrate", "narrateStatus",
      "plan", "lineart", "annotate", "updateAnnotation", "preview",
      "skipConfirmation", "render", "poll", "deliver", "verifyExample",
    ]) {
      expect(router, `whiteboardRouter 缺 procedure：${procedure}`).toContain(`${procedure}:`);
    }
  });

  it("确认关留痕写进五元事件账本（跳过必须显式留痕，不是「什么都没做」）", () => {
    const router = read("apps/server/src/video/whiteboard/router.ts");
    expect(router).toContain("gatewayAppendOnClient");
    expect(router).toContain("whiteboard.gate.");
    expect(router).toContain('outcome === "presented"');
    expect(router).toContain('outcome: "skipped"');
  });

  it("渲染经唯一写入口（submitGenJob）而不是自己 INSERT render_jobs", () => {
    const router = read("apps/server/src/video/whiteboard/router.ts");
    expect(router).toContain("submitGenJob");
    expect(router).not.toContain("INSERT INTO render_jobs");
    // G8 烧算力前置门：与 renderRouter.submit 同口径（loadActiveRulesInTx + judge）
    expect(router).toContain("loadActiveRulesInTx");
    expect(router).toContain("judge({");
  });

  it("环境变量在 .env.example 有完整注释（部署方不用翻代码）", () => {
    const env = read(".env.example");
    for (const key of [
      "WHITEBOARD_ENABLED", "WHITEBOARD_ENGINE_DIR", "WHITEBOARD_JOBS_DIR", "WHITEBOARD_LINEART",
      "WHITEBOARD_FPS", "WHITEBOARD_CAP_LONG_EDGE", "WHITEBOARD_LINEART_RETRY",
      "WHITEBOARD_NARRATION_PROFILE", "WHITEBOARD_NARRATION_LUFS", "WHITEBOARD_VOICE_LUFS",
    ]) {
      expect(env, `.env.example 缺 ${key}`).toContain(key);
    }
  });

  it("对外成片不用上游带作者标识的执笔手素材，改用本仓自有中性素材", () => {
    const router = read("apps/server/src/video/whiteboard/router.ts");
    const engineTs = read("apps/server/src/video/whiteboard/engine.ts");
    expect(engineTs).toContain("assets/whiteboard/drawing-hand-workloom.png");
    expect(router).not.toContain("assets/drawing-hand.png");
    expect(existsSync(join(REPO_ROOT, "assets/whiteboard/drawing-hand-workloom.png"))).toBe(true);
    // 中性素材由本仓工具可重生成（可审计，不是凭空来的二进制）
    const tools = read("scripts/whiteboard/lineart_tools.py");
    expect(tools).toContain("def cmd_hand");
  });
});
