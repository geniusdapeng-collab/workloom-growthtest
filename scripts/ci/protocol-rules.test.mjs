import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  validateCommit,
  exclusiveModuleOf,
  findFileOverlaps,
  findModuleConflicts,
  isExemptSubject,
  layerForRepo,
  resolveLockOverlapMode,
  resolveLockPolicies,
  parseNameStatusZ,
  requireRepositoryPath,
  validateSubject,
} from "./protocol-rules.mjs";

describe("提交信息规则", () => {
  it("接受合法提交并拒绝缺任务号", () => {
    const ok = validateSubject("feat(hotel): 徽章自动生成 [T-2026-0918-0042]", { repoSlug: "workloom-hotel" });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.warnings, []);
    const missing = validateSubject("feat(hotel): 徽章自动生成", { repoSlug: "workloom-hotel" });
    assert.ok(missing.errors.some((error) => error.includes("任务号")));
  });

  it("未知 type 失败；layer 不符仅告警", () => {
    assert.ok(validateSubject("ciish(hotel): x [T-2026-0918-0042]", { repoSlug: "workloom-hotel" }).errors.length >= 1);
    const wrongLayer = validateSubject("feat(base): x [T-2026-0918-0042]", { repoSlug: "workloom-hotel" });
    assert.deepEqual(wrongLayer.errors, []);
    assert.ok(wrongLayer.warnings.some((warning) => warning.includes("与本仓不符")));
  });

  it("过渡期祖父规则：早于阈值的提交只校 type", () => {
    const legacy = validateCommit({ subject: "chore(ui): 升级共享 UI 0.1.2", date: "2026-09-18T12:00:00+08:00" }, { repoSlug: "workloom-hotel" });
    assert.deepEqual(legacy.errors, []);
    assert.ok(legacy.warnings.length >= 1);
    const strict = validateCommit({ subject: "chore(ui): 升级共享 UI 0.1.2", date: "2026-09-19T12:00:00+08:00" }, { repoSlug: "workloom-hotel" });
    assert.ok(strict.errors.some((error) => error.includes("任务号")));
  });

  it("豁免自动化与审计提交", () => {
    for (const subject of ["sync(base): 基座下发", "chore(ci): 调整流水线", "HP-31 共同根因", "Merge branch 'main'", "Revert \"fix: x\"", "rescue: preserve tree"]) {
      assert.equal(isExemptSubject(subject), true, subject);
      const result = validateSubject(subject, { repoSlug: "workloom-im" });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.warnings, []);
    }
  });

  it("过渡开关允许缺任务号但保留格式校验", () => {
    const ok = validateSubject("docs(base): 说明", { repoSlug: "workloom-im", requireTaskId: false });
    assert.deepEqual(ok.errors, []);
    const bad = validateSubject("docs: 说明", { repoSlug: "workloom-im", requireTaskId: false });
    assert.ok(bad.errors.length >= 1);
  });

  it("layer 映射覆盖九仓", () => {
    assert.equal(layerForRepo("workloom-ai/workloom-im"), "base");
    assert.equal(layerForRepo("workloom-ai/panda-cineforge"), "ecom");
    assert.equal(layerForRepo("unknown/repo"), null);
  });
});

describe("并发冲突规则", () => {
  it("识别模块级互斥路径", () => {
    assert.equal(exclusiveModuleOf("sync/base-sync.mjs"), "sync/");
    assert.equal(exclusiveModuleOf("protocol/roles.yaml"), "protocol/");
    assert.equal(exclusiveModuleOf("packages/db/migrations/0001.sql"), "migrations/");
    assert.equal(exclusiveModuleOf("package.json"), "root:package.json");
    assert.equal(exclusiveModuleOf("apps/web/src/a.ts"), null);
  });

  it("不同文件但同一互斥模块也算冲突", () => {
    assert.deepEqual(findModuleConflicts(["sync/a.mjs"], ["sync/b.mjs"]), ["sync/"]);
    assert.deepEqual(findModuleConflicts(["apps/web/a.ts"], ["apps/web/b.ts"]), []);
  });

  it("同文件重叠判定", () => {
    assert.deepEqual(findFileOverlaps(["a/b.ts", "c/d.ts"], ["c/d.ts"]), ["c/d.ts"]);
    assert.deepEqual(findFileOverlaps(["a/b.ts"], ["x/y.ts"]), []);
  });

  it("push 事件降级为提醒：合并已发生，跨 PR 重叠不再判红（回归 2026-09-27 main 误报）", () => {
    assert.equal(resolveLockOverlapMode({ event: "push" }), "warn");
    // 普通路径提醒；明确模块互斥由独立策略保持 PR 硬约束。
    assert.equal(resolveLockOverlapMode({ event: "pull_request" }), "warn");
    assert.equal(resolveLockOverlapMode({ event: null }), "warn");
    // 显式覆盖与人工严格模式优先
    assert.equal(resolveLockOverlapMode({ event: "push", envMode: "fail" }), "fail");
    assert.equal(resolveLockOverlapMode({ event: "pull_request", envMode: "warn" }), "warn");
    assert.equal(resolveLockOverlapMode({ event: "pull_request", envMode: "warn", strict: true }), "fail");
  });
});

describe("路径解析与误判防护", () => {
  it("不同目录的同名文件不算冲突", () => {
    assert.deepEqual(findFileOverlaps(["apps/web/package.json"], ["apps/webb/package.json"]), []);
    assert.deepEqual(findModuleConflicts(["apps/web/package.json"], ["apps/webb/package.json"]), []);
  });

  it("根级 package.json 属于互斥模块，子目录 package.json 不属于", () => {
    assert.equal(exclusiveModuleOf("package.json"), "root:package.json");
    assert.equal(exclusiveModuleOf("apps/web/package.json"), null);
  });
});


describe("本仓 L2 独立策略与 NUL 路径契约", () => {
  it("普通默认提醒，PR 模块与 API 保持独立硬失败", () => {
    assert.deepEqual(resolveLockPolicies({ event: "pull_request", envMode: "warn" }), { ordinary: "warn", modules: "fail", api: "fail" });
    assert.deepEqual(resolveLockPolicies({ event: "push" }), { ordinary: "warn", modules: "warn", api: "fail" });
    assert.deepEqual(resolveLockPolicies({ event: "push", envMode: "fail" }), { ordinary: "fail", modules: "warn", api: "fail" });
    assert.deepEqual(resolveLockPolicies({ event: "push", strict: true }), { ordinary: "fail", modules: "fail", api: "fail" });
  });
  it("拒绝未知模式，不能默认为宽松", () => {
    for (const envMode of ["off", "WARN", "anything", true, 1]) assert.throws(() => resolveLockPolicies({ envMode }), /LOCK_MODE_INVALID/);
  });
  it("删除、类型变化、rename/copy 的旧新路径和特殊字符不丢失", () => {
    assert.deepEqual(parseNameStatusZ("D\0gone\0T\0type\0R100\0sync/old\0new\0C75\0copy-old\0copy-new\0M\0line\nbreak\0A\0 中文 \0"),
      ["gone", "type", "sync/old", "new", "copy-old", "copy-new", "line\nbreak", " 中文 "].sort());
  });
  it("合法空 diff 不制造其它范围", () => { assert.deepEqual(parseNameStatusZ(""), []); });
  it("拒绝无 NUL、未知状态与缺 rename 新路径", () => {
    for (const output of ["M\0a", "?\0a\0", "R100\0a\0", "M\0\0", "R101\0a\0b\0"]) assert.throws(() => parseNameStatusZ(output), /PATH_UNVERIFIED/);
  });
  it("保留仓内完整相对路径并拒绝逃逸", () => {
    for (const path of ["apps/web/package.json", "tab\tname", "line\nbreak", " 中文 "]) assert.equal(requireRepositoryPath(path), path);
    for (const path of ["", "/absolute", "C:/absolute", "../escape", "a/../escape", "a//b", "./a", "a\\b", "a\0b", "%2e%2e/escape"]) assert.throws(() => requireRepositoryPath(path), /PATH_UNVERIFIED/);
  });
});
