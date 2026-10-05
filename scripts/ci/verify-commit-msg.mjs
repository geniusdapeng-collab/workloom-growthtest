#!/usr/bin/env node
/**
 * 提交信息校验（docs/DEVELOPMENT-PROTOCOL.md §5）。
 *
 * 用法：
 *   node scripts/ci/verify-commit-msg.mjs                 # PR 校验 target..source；push 校验 before..HEAD
 *   node scripts/ci/verify-commit-msg.mjs --range A..B    # 指定范围
 *   node scripts/ci/verify-commit-msg.mjs --self-test     # 只跑内置样例，不读 git
 *   PROTOCOL_TASK_ID_OPTIONAL=1 node ...                  # 过渡期：只校格式，不强制任务号
 */
import { execFileSync } from "node:child_process";
import { isExemptSubject, parseCommitLog, validateCommit } from "./protocol-rules.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/i;
const ZERO_SHA = "0".repeat(40);
const COMMIT_FORMAT = "%H\u001f%cI\u001f%s";
// These events use a premerge checkout. target/merged/NPC events use different
// checkouts and must not silently inherit the premerge commit-range contract.
const PREMERGE_EVENTS = new Set([
  "pull_request", "pull_request.update", "pull_request.approved",
  "pull_request.changes_requested", "pull_request.mergeable", "pull_request.comment",
]);

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function fail(code, message) {
  throw new Error(`${code}: ${message}`);
}

function fullSha(value, prefix, required = false) {
  if (required && !value?.trim()) fail(`${prefix}_REQUIRED`, "缺少权威完整 SHA，不能退回 HEAD");
  const sha = value?.trim().toLowerCase();
  if (!sha || !FULL_SHA.test(sha) || sha === ZERO_SHA) fail(`${prefix}_INVALID`, "必须是非零的完整 40 位提交 SHA");
  return sha;
}

function requireCommit(sha, prefix) {
  try {
    if (git(["cat-file", "-t", sha]) === "commit") return;
  } catch { /* Report a stable reason without falling back to a different commit. */ }
  fail(`${prefix}_COMMIT_UNAVAILABLE`, `${sha} 不是本地可读取的提交；请取得所需 Git 对象后重跑`);
}

function resolveHead() {
  try {
    const head = git(["rev-parse", "--verify", "HEAD"]);
    requireCommit(head, "CHECKOUT");
    return head;
  } catch (error) {
    fail("CHECKOUT_UNAVAILABLE", `不能读取当前 Git 提交：${error.message}`);
  }
}

function requireNonemptyRange(range, prefix) {
  try {
    if (Number(git(["rev-list", "--count", range])) > 0) return;
  } catch { fail(`${prefix}_RANGE_UNAVAILABLE`, `不能读取提交范围 ${range}`); }
  fail(`${prefix}_SOURCE_RANGE_EMPTY`, `范围 ${range} 没有新增提交，不能以空列表放行`);
}

function requireCompleteHistory(prefix) {
  let shallow;
  try { shallow = git(["rev-parse", "--is-shallow-repository"]); }
  catch { fail(`${prefix}_HISTORY_UNAVAILABLE`, "不能核对 Git 历史完整性"); }
  if (shallow !== "false") {
    fail(`${prefix}_HISTORY_INCOMPLETE`, "浅克隆会截断提交范围；请取得完整历史后重跑，不能只校验可见片段");
  }
}

function optionalBinding(name, expected, shaPrefix, mismatchCode) {
  if (process.env[name] === undefined) return;
  const actual = fullSha(process.env[name], shaPrefix);
  if (actual !== expected) fail(mismatchCode, `${name}=${actual} 与本次绑定 ${expected} 不一致`);
}

function resolvePrScope(explicit, event) {
  // CNB defaults: https://docs.cnb.cool/zh/build/build-in-env.html
  // CNB_COMMIT names source for pull_request, target for pull_request.mergeable;
  // the workspace is a synthetic merge, so before..HEAD includes target history.
  const source = fullSha(process.env.CNB_PULL_REQUEST_SHA, "PR_SOURCE_SHA", true);
  const target = fullSha(process.env.CNB_PULL_REQUEST_TARGET_SHA, "PR_TARGET_SHA", true);
  requireCommit(source, "PR_SOURCE");
  requireCommit(target, "PR_TARGET");
  requireCompleteHistory("PR");
  const range = `${target}..${source}`;
  requireNonemptyRange(range, "PR");
  optionalBinding("CNB_COMMIT", event === "pull_request.mergeable" ? target : source, "PR_COMMIT_SHA", "PR_SOURCE_BINDING_MISMATCH");
  optionalBinding("CNB_BRANCH_SHA", target, "PR_BRANCH_SHA", "PR_TARGET_BINDING_MISMATCH");
  const head = resolveHead();
  optionalBinding("CNB_PULL_REQUEST_MERGE_SHA", head, "PR_MERGE_SHA", "PR_CHECKOUT_BINDING_MISMATCH");
  const parents = git(["show", "-s", "--format=%P", head]).split(" ").filter(Boolean);
  if (parents.length !== 2 || parents[0] !== target || parents[1] !== source) {
    fail("PR_CHECKOUT_BINDING_MISMATCH", `checkout ${head} 的父提交必须依次是 target ${target} 和 source ${source}`);
  }
  if (explicit !== undefined && explicit !== range) {
    fail("PR_RANGE_OVERRIDE_FORBIDDEN", `PR 只能校验已经绑定的 ${range}`);
  }
  return { range, tip: source, single: false };
}

function resolveExplicitScope(explicit) {
  // Local/manual callers may use refs, but never Git options or path expressions.
  const parts = explicit.split("..");
  if (parts.length > 2 || parts.some((part) => !/^[a-z0-9][a-z0-9_./~^@{}-]*$/i.test(part))) {
    fail("EXPLICIT_RANGE_UNAVAILABLE", "--range 必须是提交引用或 A..B，不能包含 Git 选项/路径");
  }
  let resolved;
  try { resolved = parts.map((part) => git(["rev-parse", "--verify", `${part}^{commit}`])); }
  catch { fail("EXPLICIT_RANGE_UNAVAILABLE", `不能读取显式范围 ${explicit}`); }
  if (resolved.length === 1) return { range: resolved[0], tip: resolved[0], single: true };
  requireCompleteHistory("EXPLICIT");
  const range = resolved.join("..");
  requireNonemptyRange(range, "EXPLICIT");
  return { range, tip: resolved[1], single: false };
}

function resolveScope() {
  const explicit = arg("--range");
  if (process.argv.includes("--range") && !explicit?.trim()) fail("EXPLICIT_RANGE_UNAVAILABLE", "--range 缺少值");
  const event = process.env.CNB_EVENT?.trim();
  const isPr = event?.startsWith("pull_request")
    || process.env.CNB_PULL_REQUEST === "true" || process.env.CNB_PULL_REQUEST_LIKE === "true"
    || Boolean(process.env.CNB_PULL_REQUEST_SHA?.trim() || process.env.CNB_PULL_REQUEST_TARGET_SHA?.trim());
  if (isPr) {
    if (!event) fail("PR_EVENT_REQUIRED", "PR 来源绑定需要 CNB_EVENT");
    if (!PREMERGE_EVENTS.has(event)) fail("PR_EVENT_CONFLICT", `事件 ${event} 不是预合并 PR 事件，不能套用该范围`);
    return resolvePrScope(explicit, event);
  }
  if (explicit !== undefined) return resolveExplicitScope(explicit);
  const head = resolveHead();
  const before = process.env.CNB_BEFORE_SHA?.trim();
  // CNB uses zero for branch creation. Missing/blank initial metadata is also
  // checked as one actual tip, including a custom merge, never its whole history.
  if (!before || before === ZERO_SHA) return { range: head, tip: head, single: true };
  const previous = fullSha(before, "PUSH_BEFORE_SHA");
  requireCommit(previous, "PUSH_BEFORE");
  requireCompleteHistory("PUSH");
  const range = `${previous}..${head}`;
  requireNonemptyRange(range, "PUSH");
  return { range, tip: head, single: false };
}

function readCommits({ range, tip, single }) {
  const tipCommit = parseCommitLog(git(["show", "-s", `--format=${COMMIT_FORMAT}`, tip]));
  if (single) return tipCommit;
  const log = git(["log", "--no-merges", `--format=${COMMIT_FORMAT}`, range, "--"]);
  const commits = parseCommitLog(log);
  // Preserve existing merge-history exemptions while checking the actual source
  // tip. A custom integration merge is a submitted commit, not the CI wrapper.
  if (!log.split("\n").some((line) => line.split("\u001f", 1)[0] === tip)) commits.unshift(...tipCommit);
  return commits;
}

function selfTest() {
  const strict = "2026-09-19T10:00:00+08:00";
  const legacy = "2026-09-18T12:00:00+08:00";
  const cases = [
    ["feat(hotel): 徽章由 manifest 生成 [T-2026-0918-0042]", "workloom-hotel", strict, true],
    ["ci(base): 新增协议门禁阶段 [T-2026-0918-0043]", "workloom-im", strict, true],
    ["docs(cnb): 补迁移手册", "workloom-im", strict, false],
    ["feat(hotel): 缺任务号", "workloom-hotel", strict, false],
    ["feat(base): 层名不符但带任务号 [T-2026-0918-0045]", "workloom-hotel", strict, true],
    ["chore(ui): 升级共享 UI 0.1.2", "workloom-hotel", legacy, true],
    ["feat(tiger): 建立行业考试题集", "workroom-tiger", legacy, true],
    ["feat(hotel): 过渡期内缺任务号", "workloom-hotel", legacy, true],
    ["HP-31 共同根因：UI 制品补 ESM 扩展名", "workloom-im", strict, true],
    ["sync(base): 基座下发", "workloom-hotel", strict, true],
    ["Merge branch 'main' into task/x", "workloom-im", strict, true],
  ];
  let failed = 0;
  for (const [subject, repoSlug, date, shouldPass] of cases) {
    const result = validateCommit({ subject, date }, { repoSlug });
    const passed = result.errors.length === 0;
    if (passed !== shouldPass) {
      failed += 1;
      console.error(`✗ self-test: "${subject}" 期望 ${shouldPass ? "通过" : "拒绝"}，实际 ${passed ? "通过" : "拒绝"} ${JSON.stringify(result.errors)}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`✓ verify-commit-msg self-test 通过（${cases.length} 例，含过渡期祖父规则）`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const repoSlug = arg("--repo") ?? process.env.CNB_REPO_SLUG ?? null;
  const requireTaskId = process.env.PROTOCOL_TASK_ID_OPTIONAL !== "1";
  const scope = resolveScope();
  const { range } = scope;
  const commits = readCommits(scope);
  if (!commits.length) {
    fail("COMMIT_SCOPE_EMPTY", `范围 ${range} 未能读取已绑定提交，不能放行`);
  }

  let failed = 0;
  for (const { sha, date, subject } of commits) {
    if (isExemptSubject(subject)) {
      console.log(`- ${sha} 豁免：${subject}`);
      continue;
    }
    const { errors, warnings } = validateCommit({ subject, date }, { repoSlug, requireTaskId });
    for (const warning of warnings) console.warn(`! ${sha} ${warning}`);
    if (errors.length) {
      failed += 1;
      console.error(`✗ ${sha} ${subject}`);
      for (const error of errors) console.error(`    - ${error}`);
    } else if (!warnings.length) {
      console.log(`✓ ${sha} ${subject}`);
    }
  }

  if (failed) {
    console.error(`\n拒绝：${failed}/${commits.length} 条提交不符合 docs/DEVELOPMENT-PROTOCOL.md §5`);
    console.error("提示：任务号来自 CNB Issue 标题 [T-YYYYMMDD-XXXX]；自动化提交请用 sync(...) / chore(ci) 或设 PROTOCOL_TASK_ID_OPTIONAL=1。");
    process.exit(1);
  }
  console.log(`\n✓ 提交信息校验通过（${commits.length} 条，范围 ${range}）`);
}

try { main(); }
catch (error) {
  console.error(`拒绝：${error.message}`);
  process.exitCode = 1;
}
