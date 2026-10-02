/**
 * 本仓客户端基座门禁的"产品分叉面"回归：
 *
 * workloom 是三端壳上的产品分叉（页面/壳/语音/引导都是获客增长产品层），
 * 因此门禁允许本仓声明自有路径——**声明的唯一事实源是 `.workloom-ui-governance.json`**
 * （由 rollout 从基座 `sync/child-repos.json` 写入：`industryExtensionPaths` +
 * `tolerateExtensionSnapshotOverlap: true`，见协议 §10.4；仓内私改会在下一次 rollout fail closed）。
 * 本测试锁定三件事：
 *  ① 没有声明时，受管指纹漂移与非白名单文件必须继续报错（声明是唯一开关，不能默认放宽）；
 *  ② 声明后这些路径被当作本仓自有（0 错误），且必备受管入口仍在受管集合里；
 *  ③ 非法声明（越界路径）必须报错，不能静默忽略。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyClientFoundationConsumer } from "./verify-client-foundation-consumer.mjs";

const ALLOWED_EXTENSIONS = [
  "apps/*/src/extensions/**",
  "apps/*/src/projections/**",
  "apps/*/src/config/industry/**",
  "apps/*/src/theme/industry/**",
  "apps/*/public/industry/**",
];
const VERSION = "0.1.1";
const roots: string[] = [];
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 造一个"已是基座消费方、但产品层与基座不一致"的最小仓骨架 */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "wl-growth-foundation-"));
  roots.push(root);
  const files: Record<string, string> = {
    "apps/web/src/main.tsx": 'export const client = "web";\n',
    "apps/webb/src/main.tsx": 'export const client = "webb";\n',
    "apps/webc/src/main.tsx": 'export const client = "webc";\n',
    "apps/webc/public/service-front.config.json": '{"industryProjectionPath":"industry/service-front.config.json"}\n',
    // 受管文件：磁盘内容与 state 指纹不一致（产品层定制）
    "apps/web/src/pages/p1/P1.tsx": 'export const p1 = "growth-own";\n',
    // 非白名单文件（基座快照里没有）
    "apps/web/src/shell/PageExitLink.tsx": 'export const exitLink = true;\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  writeJson(join(root, ".workloom-client-foundation.json"), {
    schemaVersion: "workloom.client-foundation-state/v1",
    baseRepository: "workloom-ai/workloom-im",
    version: VERSION,
    sourceRef: `refs/tags/ui-v${VERSION}`,
    sourceCommit: "a".repeat(40),
    updatePolicy: "upgrade-pr-only",
    clients: { bPc: "apps/web", bMobile: "apps/webb", cMobile: "apps/webc" },
    allowedIndustryExtensionPaths: ALLOWED_EXTENSIONS,
    managedFiles: {
      "apps/web/src/main.tsx": { sha256: sha256(files["apps/web/src/main.tsx"]!), mode: 420 },
      "apps/webb/src/main.tsx": { sha256: sha256(files["apps/webb/src/main.tsx"]!), mode: 420 },
      "apps/webc/src/main.tsx": { sha256: sha256(files["apps/webc/src/main.tsx"]!), mode: 420 },
      "apps/webc/public/service-front.config.json": { sha256: sha256(files["apps/webc/public/service-front.config.json"]!), mode: 420 },
      // 指纹来自基座快照（这里用另一段内容模拟"基座版"）
      "apps/web/src/pages/p1/P1.tsx": { sha256: sha256('export const p1 = "base";\n'), mode: 420 },
    },
  });
  writeJson(join(root, ".workloom-ui.json"), { package: "@workloom/ui", version: VERSION });
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("客户端基座门禁 · 本仓产品分叉声明", () => {
  it("没有声明文件时：指纹漂移与非白名单文件继续报错", () => {
    const errors = verifyClientFoundationConsumer(fixtureRepo());
    expect(errors.some((error) => error.includes("指纹漂移：apps/web/src/pages/p1/P1.tsx"))).toBe(true);
    expect(errors.some((error) => error.includes("非白名单行业文件：apps/web/src/shell/PageExitLink.tsx"))).toBe(true);
  });

  it("声明为本仓自有后：0 错误，且必备受管入口仍在受管集合内", () => {
    const root = fixtureRepo();
    writeJson(join(root, ".workloom-ui-governance.json"), {
      schemaVersion: "workloom.ui-governance-state/v1",
      industryExtensionPaths: ["apps/*/src/pages/**", "apps/*/src/shell/**"],
      tolerateExtensionSnapshotOverlap: true,
    });
    expect(verifyClientFoundationConsumer(root)).toEqual([]);

    // 必备入口仍是受管文件：把它删掉必须报错（防止用声明把基座入口一并豁免）
    rmSync(join(root, "apps/webb/src/main.tsx"));
    const errors = verifyClientFoundationConsumer(root);
    expect(errors.some((error) => error.includes("apps/webb/src/main.tsx"))).toBe(true);
  });

  it("非法声明路径（越界）必须报错，不能静默忽略", () => {
    const root = fixtureRepo();
    writeJson(join(root, ".workloom-ui-governance.json"), {
      schemaVersion: "workloom.ui-governance-state/v1",
      industryExtensionPaths: ["apps/../etc/**"],
      tolerateExtensionSnapshotOverlap: true,
    });
    const errors = verifyClientFoundationConsumer(root);
    expect(errors.some((error) => error.includes("仓级行业扩展路径非法"))).toBe(true);
  });
});
