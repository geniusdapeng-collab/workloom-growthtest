/**
 * 弹层出口全量回归（可用性门禁，跨三端扫描）。
 *
 * 规则：任何一个**弹层渲染点**（Overlay/Dialog/Drawer/Sheet/FullscreenSurface/ConfirmDialog/Popover）
 * 都必须在属性窗口里给出关闭路径——onClose、dismissOnBackdrop/dismissOnEscape，或页脚「取消/关闭」。
 * 背景：曾出现"进得来出不去"的页面；弹层比页面更隐蔽（Esc 失灵 + 无关闭按钮 = 用户被锁死）。
 *
 * 扫描范围是 apps/web、apps/webb、apps/webc 三个客户端的全部 .tsx（含 pages/extensions/components/shell），
 * 并断言渲染点数不低于下限，避免正则失配后门禁"空跑变绿"。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const APPS = ["apps/web/src", "apps/webb/src", "apps/webc/src"];
const OVERLAY_TAG = /<(Overlay|Dialog|Drawer|Sheet|FullscreenSurface|ConfirmDialog|Popover)\b/;
const CLOSING_TAG = /<\//;
const EXIT_PROPS = /onClose|dismissOnBackdrop|dismissOnEscape|取消|关闭|收起|返回|退出/;
const WINDOW = 12;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".tsx") && !path.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

interface Violation { file: string; line: number; tag: string }

function scan(): { points: number; violations: Violation[] } {
  const violations: Violation[] = [];
  let points = 0;
  for (const app of APPS) {
    for (const file of walk(join(REPO, app))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const match = OVERLAY_TAG.exec(line);
        if (!match || CLOSING_TAG.test(line)) return;
        points += 1;
        const window = lines.slice(index, index + WINDOW).join("\n");
        if (!EXIT_PROPS.test(window)) {
          violations.push({ file: relative(REPO, file), line: index + 1, tag: match[1]! });
        }
      });
    }
  }
  return { points, violations };
}

describe("弹层出口（关闭/取消/Esc/背景）全量覆盖", () => {
  const { points, violations } = scan();

  it("三端每个弹层渲染点都能退出", () => {
    expect(
      violations,
      `弹层缺少关闭路径：${violations.map((v) => `${v.file}:${v.line} <${v.tag}>`).join("、")}`,
    ).toEqual([]);
  });

  it("扫描覆盖面不缩水（渲染点数下限）", () => {
    /**
     * 当前三端共 14 个"开口标签"渲染点（Overlay / ConfirmDialog / Drawer 等）。
     * 2026-09-21：基座通用审批环节移除后，审批中心页（P4）与两处审批弹层随之下线，
     * 渲染点由 21 降到 14；下限同步取 14，仍作为漂移探测器（路径或正则失配会骤降）。
     * 注意：本测试统计的是 `<Overlay` 这类**开口标签**，闭合标签 `</Overlay>` 不计。
     */
    expect(points).toBeGreaterThanOrEqual(14);
  });
});
