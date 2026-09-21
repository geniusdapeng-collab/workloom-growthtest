import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRepoRoot } from "../src/paths.mjs";
import { createPolicyClient } from "../src/policy-client.mjs";

test("策略桥加载真实围栏包并复用围栏引擎裁决", async (t) => {
  const policy = createPolicyClient({ repoRoot: resolveRepoRoot() });
  t.after(() => policy.close());
  const packs = await policy.packs();
  assert.ok(packs.activeRules > 50, `activeRules=${packs.activeRules}`);
  assert.ok(packs.packs.length >= 3, `packs=${packs.packs.length}`);

  const publish = await policy.judge({
    object: { type: "publish_task" },
    action: "publish.execute",
    effect: "write",
    context: { account_daily_published: 0 },
  });
  assert.equal(publish.level, "review");
  assert.ok(publish.impacts.some((impact) => impact.rule_id === "G9"));

  const overLimit = await policy.judge({
    object: { type: "publish_task" },
    action: "publish.execute",
    effect: "write",
    context: { account_daily_published: 7 },
  });
  assert.equal(overLimit.level, "block");
  assert.ok(overLimit.impacts.some((impact) => impact.rule_id === "G9b"));

  const missingContext = await policy.judge({
    object: { type: "publish_task" },
    action: "publish.execute",
    effect: "write",
    context: {},
  });
  assert.equal(missingContext.level, "block");
  assert.ok(missingContext.evalErrors.length > 0, "缺上下文应 fail-closed 并留痕");

  const factRedline = await policy.judge({
    object: { type: "content" },
    action: "content.submit",
    effect: "write",
    context: { fact_check_passed: false },
  });
  assert.equal(factRedline.level, "block");
  assert.ok(factRedline.impacts.some((impact) => impact.rule_id === "G-GEO2"));

  const dailyCollab = await policy.judge({
    object: { type: "script" },
    action: "draft",
    effect: "write",
    context: {},
  });
  assert.equal(dailyCollab.level, "auto");
});

test("手势校验复用 review-console：驳回必填原因、readonly 拒绝", async (t) => {
  const policy = createPolicyClient({ repoRoot: resolveRepoRoot() });
  t.after(() => policy.close());
  await assert.rejects(() => policy.validateGesture({ type: "reject" }, "owner"), /EMPTY_REASON/);
  await assert.rejects(() => policy.validateGesture({ type: "edit" }, "owner"), /EDIT_REQUIRES_AFTER/);
  await assert.rejects(() => policy.validateGesture({ type: "approve" }, "readonly"), /FORBIDDEN_ROLE/);
  const ok = await policy.validateGesture({ type: "reject", reasonEnum: "risk", reasonText: "风险过高" }, "owner");
  assert.equal(ok.ok, true);
});
