import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The override is only a RED fixture input. The production verifier has no such override.
const verifier = process.env.COMMIT_VERIFIER_UNDER_TEST
  ?? fileURLToPath(new URL("./verify-commit-msg.mjs", import.meta.url));
const directories = [];
const valid = "fix(growth): source change [T-2026-1005-0001]";
const invalid = "fix(growth): source change (T-2026-1005-0001)";
const oldInvalid = "fix(acceptance): already on main (T-2026-1004-0903)";
const gitEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_DATE: "2026-10-05T10:00:00+08:00",
  GIT_COMMITTER_DATE: "2026-10-05T10:00:00+08:00",
};

afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture({ sourceSubject = valid, legacyTarget = true, sourceMergeSubject } = {}) {
  const root = mkdtempSync(join(tmpdir(), "commit-range-git-"));
  directories.push(root);
  const git = (...args) => execFileSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args,
  ], { cwd: root, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Local commit range fixture");
  git("config", "user.email", "fixture@example.invalid");
  let serial = 0;
  const commit = (subject, file = "file-" + (++serial) + ".txt") => {
    writeFileSync(join(root, file), "real fixture content " + serial + "\n");
    git("add", file);
    git("commit", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  const base = commit("docs(growth): shared baseline [T-2026-1005-0001]");
  git("switch", "-c", "source");
  const previousSource = commit(sourceSubject, "source.txt");
  git("switch", "main");
  commit("docs(growth): old main documentation [T-2026-1004-0903]", "old-docs.txt");
  const oldBad = commit(legacyTarget ? oldInvalid : "fix(growth): old main repair [T-2026-1004-0903]", "old-main.txt");
  const target = commit("docs(growth): target tip [T-2026-1004-0903]", "target-tip.txt");
  let source = previousSource;
  if (sourceMergeSubject) {
    git("switch", "source");
    git("merge", "--no-ff", "-m", sourceMergeSubject, target);
    source = git("rev-parse", "HEAD");
    git("switch", "main");
  }
  git("merge", "--no-ff", "-m", "Merged source into target", source);
  const merge = git("rev-parse", "HEAD");
  const env = {
    CNB_EVENT: "pull_request", CNB_PULL_REQUEST: "true", CNB_PULL_REQUEST_LIKE: "true",
    CNB_PULL_REQUEST_SHA: source, CNB_PULL_REQUEST_TARGET_SHA: target,
    CNB_PULL_REQUEST_MERGE_SHA: merge, CNB_COMMIT: source, CNB_BRANCH_SHA: target,
    CNB_BEFORE_SHA: previousSource, CNB_REPO_SLUG: "fixture/workloom",
  };
  return { root, git, commit, base, previousSource, source, target, merge, oldBad, env };
}

function run(f, { env = {}, args = [], pr = true } = {}) {
  const variables = pr ? { ...f.env, ...env } : { CNB_EVENT: "push", CNB_REPO_SLUG: "fixture/workloom", ...env };
  for (const [key, value] of Object.entries(variables)) if (value === undefined) delete variables[key];
  const result = spawnSync(process.execPath, [verifier, ...args], {
    cwd: f.root, encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", ...variables },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, "the actual verifier must complete rather than time out");
  return { ...result, output: (result.stdout ?? "") + (result.stderr ?? "") };
}
function shallowFixture(f) {
  const root = mkdtempSync(join(tmpdir(), "commit-range-shallow-"));
  directories.push(root);
  f.git("clone", "--no-local", "--depth=1", "file://" + f.root, root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
  // Fetch just the authoritative tips. Existence of these objects does not prove
  // that all newly introduced source ancestors are available to the checker.
  git("fetch", "--depth=1", "origin", f.source, f.target);
  assert.equal(git("cat-file", "-t", f.source), "commit");
  assert.equal(git("cat-file", "-t", f.target), "commit");
  assert.equal(git("rev-parse", "--is-shallow-repository"), "true");
  return { root, git, env: f.env };
}
function fastForwardFixture(options = {}) {
  const f = fixture({ sourceMergeSubject: valid, ...options });
  f.git("checkout", "--detach", f.target);
  // Exact real CNB Prepare command: no --no-ff, so ancestor target fast-forwards.
  f.git("merge", "--quiet", "--no-edit", f.source);
  assert.equal(f.git("rev-parse", "HEAD"), f.source);
  assert.equal(f.git("rev-parse", f.merge + "^{tree}"), f.git("rev-parse", "HEAD^{tree}"));
  return f;
}
function mergeProof(f, { tree = f.git("rev-parse", f.merge + "^{tree}"), parents = [f.target, f.source], message = "Canonical or local runner merge proof" } = {}) {
  return f.git("commit-tree", tree, ...parents.flatMap((sha) => ["-p", sha]), "-m", message);
}
function alteredTree(f) {
  f.commit(valid, "tampered-tree.txt");
  const tree = f.git("rev-parse", "HEAD^{tree}");
  f.git("checkout", "--detach", f.source);
  return tree;
}
function pass(result) { assert.equal(result.status, 0, result.output); }
function refuse(result, code) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, new RegExp(code), result.output);
}

describe("PR commit scope is the authoritative target..source, not the synthetic checkout difference", () => {
  it("ignores invalid commits already on target when before names a previous source tip", () => {
    const f = fixture({ sourceMergeSubject: valid });
    const result = run(f);
    pass(result);
    assert.match(result.output, new RegExp(f.target + "\\.\\." + f.source));
    assert.ok(!result.output.includes(oldInvalid), result.output);
    assert.ok(!result.output.includes(f.oldBad.slice(0, 12)), result.output);
    assert.ok(result.output.includes(f.previousSource.slice(0, 12)), result.output);
    assert.ok(result.output.includes(f.source.slice(0, 12)), "actual source merge subject must be checked");
    assert.ok(!result.output.includes(f.merge.slice(0, 12)), "synthetic merge title is not a source commit");
  });
  it("handles a source that diverged before target's old invalid commits without a source integration merge", () => {
    const f = fixture();
    const result = run(f, { env: { CNB_BEFORE_SHA: f.base } });
    pass(result);
    assert.ok(result.output.includes(f.source.slice(0, 12)));
    assert.ok(!result.output.includes(oldInvalid));
  });
  it("still rejects a newly introduced invalid source subject", () => {
    const f = fixture({ sourceSubject: invalid });
    refuse(run(f), "任务号");
  });
  for (const subject of [
    "fix(growth): custom source merge without a task",
    "fix(growth): custom source merge (T-2026-1005-0001)",
    "oops(growth): unsupported source merge [T-2026-1005-0001]",
  ]) it("validates the actual source merge subject: " + subject, () => {
    const f = fixture({ sourceMergeSubject: subject });
    const result = run(f);
    assert.notEqual(result.status, 0, result.output);
    assert.ok(result.output.includes(f.source.slice(0, 12)), result.output);
    assert.ok(!result.output.includes(oldInvalid), "target-only history must remain excluded");
  });
  it("retains the existing standard Merge exemption while checking the actual source tip", () => {
    const f = fixture({ sourceMergeSubject: "Merge branch 'main' into source" });
    const result = run(f);
    pass(result);
    assert.ok(result.output.includes(f.source.slice(0, 12)));
    assert.match(result.output, /豁免/);
  });
  it("includes a valid actual merge-only source rather than declaring an empty no-merges list green", () => {
    const f = fixture({ legacyTarget: false });
    f.git("switch", "source");
    f.git("merge", "--no-ff", "-m", valid, f.target);
    f.source = f.git("rev-parse", "HEAD");
    // Move target to include the source's sole non-merge commit, then bind a real new wrapper.
    f.target = f.previousSource;
    f.git("checkout", "--detach", f.target);
    f.git("merge", "--no-ff", "-m", "Merged current source", f.source);
    f.merge = f.git("rev-parse", "HEAD");
    const result = run(f, { env: {
      CNB_PULL_REQUEST_SHA: f.source, CNB_PULL_REQUEST_TARGET_SHA: f.target,
      CNB_PULL_REQUEST_MERGE_SHA: f.merge, CNB_COMMIT: f.source, CNB_BRANCH_SHA: f.target,
    } });
    pass(result);
    assert.ok(result.output.includes(f.source.slice(0, 12)));
    assert.ok(!result.output.includes("无提交"));
  });
  it("allows an explicit range only when it is the exact validated PR range", () => {
    const f = fixture();
    pass(run(f, { args: ["--range", f.target + ".." + f.source] }));
  });
  it("does not let an explicit checkout range bypass PR authority", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { args: ["--range", "HEAD~1..HEAD"] }), "PR_RANGE_OVERRIDE_FORBIDDEN");
  });
  it("recognizes documented mergeable events whose CNB_COMMIT names target", () => {
    const f = fixture();
    pass(run(f, { env: { CNB_EVENT: "pull_request.mergeable", CNB_COMMIT: f.target, CNB_PULL_REQUEST: "false" } }));
  });
  it("recognizes approved events even when the basic PR flag is false and no merge SHA is supplied", () => {
    const f = fixture();
    pass(run(f, { env: { CNB_EVENT: "pull_request.approved", CNB_PULL_REQUEST: "false", CNB_PULL_REQUEST_MERGE_SHA: undefined } }));
  });
  it("can prove checkout parents when only the mandatory source/target metadata is present", () => {
    const f = fixture();
    pass(run(f, { env: { CNB_COMMIT: undefined, CNB_BRANCH_SHA: undefined, CNB_PULL_REQUEST_MERGE_SHA: undefined } }));
  });
  for (const event of ["pull_request.update", "pull_request.changes_requested", "pull_request.comment"]) {
    it("binds documented source metadata for premerge event " + event, () => {
      const f = fixture();
      pass(run(f, { env: { CNB_EVENT: event } }));
    });
  }
});

describe("PR binding failures never fall back to HEAD or an empty apparent success", () => {
  const cases = [
    ["missing source", { CNB_PULL_REQUEST_SHA: undefined }, "PR_SOURCE_SHA_REQUIRED"],
    ["blank source", { CNB_PULL_REQUEST_SHA: " " }, "PR_SOURCE_SHA_REQUIRED"],
    ["missing target", { CNB_PULL_REQUEST_TARGET_SHA: undefined }, "PR_TARGET_SHA_REQUIRED"],
    ["blank target", { CNB_PULL_REQUEST_TARGET_SHA: " " }, "PR_TARGET_SHA_REQUIRED"],
    ["abbreviated source", { CNB_PULL_REQUEST_SHA: "1234567" }, "PR_SOURCE_SHA_INVALID"],
    ["nonhex source", { CNB_PULL_REQUEST_SHA: "z".repeat(40) }, "PR_SOURCE_SHA_INVALID"],
    ["zero source", { CNB_PULL_REQUEST_SHA: "0".repeat(40) }, "PR_SOURCE_SHA_INVALID"],
    ["abbreviated target", { CNB_PULL_REQUEST_TARGET_SHA: "1234567" }, "PR_TARGET_SHA_INVALID"],
    ["unknown source object", { CNB_PULL_REQUEST_SHA: "a".repeat(40) }, "PR_SOURCE_COMMIT_UNAVAILABLE"],
    ["unknown target object", { CNB_PULL_REQUEST_TARGET_SHA: "a".repeat(40) }, "PR_TARGET_COMMIT_UNAVAILABLE"],
    ["push event with PR flags", { CNB_EVENT: "push" }, "PR_EVENT_CONFLICT"],
    ["stale commit binding", { CNB_COMMIT: "a".repeat(40) }, "PR_SOURCE_BINDING_MISMATCH"],
    ["stale branch binding", { CNB_BRANCH_SHA: "a".repeat(40) }, "PR_TARGET_BINDING_MISMATCH"],
    ["stale merge binding", { CNB_PULL_REQUEST_MERGE_SHA: "a".repeat(40) }, "PR_CHECKOUT_BINDING_MISMATCH"],
    ["malformed merge binding", { CNB_PULL_REQUEST_MERGE_SHA: "--all" }, "PR_MERGE_SHA_INVALID"],
    ["empty declared commit binding", { CNB_COMMIT: "" }, "PR_COMMIT_SHA_INVALID"],
    ["abbreviated declared commit binding", { CNB_COMMIT: "1234567" }, "PR_COMMIT_SHA_INVALID"],
    ["malformed branch binding", { CNB_BRANCH_SHA: "--all" }, "PR_BRANCH_SHA_INVALID"],
    ["missing event", { CNB_EVENT: undefined }, "PR_EVENT_REQUIRED"],
  ];
  for (const [label, env, code] of cases) it("rejects " + label + " with an explicit binding failure", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { env }), code);
  });
  it("rejects a tree object even though it is an existing full SHA", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { env: { CNB_PULL_REQUEST_SHA: f.git("rev-parse", f.source + "^{tree}") } }), "PR_SOURCE_COMMIT_UNAVAILABLE");
  });
  it("rejects a source tip already equal to target", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { env: { CNB_PULL_REQUEST_SHA: f.target, CNB_COMMIT: f.target } }), "PR_SOURCE_RANGE_EMPTY");
  });
  it("rejects a source ancestor already wholly present in target", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { env: { CNB_PULL_REQUEST_SHA: f.base, CNB_COMMIT: f.base } }), "PR_SOURCE_RANGE_EMPTY");
  });
  it("rejects a checkout whose target parent differs from the declared target", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { env: { CNB_PULL_REQUEST_TARGET_SHA: f.base, CNB_BRANCH_SHA: f.base } }), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("rejects direct target checkout rather than inspecting its valid HEAD as the PR source", () => {
    const f = fixture({ legacyTarget: false });
    f.git("checkout", "--detach", f.target);
    refuse(run(f), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("rejects an unrelated child added after the expected synthetic merge", () => {
    const f = fixture({ legacyTarget: false });
    f.commit(valid, "post-merge.txt");
    refuse(run(f), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("rejects a declared target/source order reversal in checkout parents", () => {
    const f = fixture({ legacyTarget: false });
    f.git("checkout", "--detach", f.source);
    f.git("merge", "--no-ff", "-m", "Merged target into source checkout", f.target);
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: undefined } }), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("checks metadata even when an explicit range would otherwise hide the missing source", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { env: { CNB_PULL_REQUEST_SHA: undefined }, args: ["--range", f.target + ".." + f.source] }), "PR_SOURCE_SHA_REQUIRED");
  });
  for (const event of ["pull_request.target", "pull_request.merged", "pull_request.comment@npc"]) {
    it("refuses a different documented checkout contract for event " + event, () => {
      const f = fixture({ legacyTarget: false });
      refuse(run(f, { env: { CNB_EVENT: event } }), "PR_EVENT_CONFLICT");
    });
  }
  it("refuses a real shallow premerge clone even when both authoritative tip objects exist", () => {
    const f = fixture({ sourceSubject: invalid, sourceMergeSubject: valid, legacyTarget: false });
    const shallow = shallowFixture(f);
    refuse(run(shallow), "PR_HISTORY_INCOMPLETE");
    shallow.git("fetch", "--unshallow", "origin");
    assert.equal(shallow.git("rev-parse", "--is-shallow-repository"), "false");
    refuse(run(shallow), "任务号");
  });
  it("accepts the same valid shallow premerge fixture only after actual local unshallow restores history", () => {
    const f = fixture({ sourceMergeSubject: valid });
    const shallow = shallowFixture(f);
    refuse(run(shallow), "PR_HISTORY_INCOMPLETE");
    shallow.git("fetch", "--unshallow", "origin");
    pass(run(shallow));
  });
});

describe("real CNB fast-forward and local merges preserve canonical merged-tree proof", () => {
  it("accepts actual fast-forward source HEAD only with full canonical merge/ancestry/tree proof and no token", () => {
    const f = fastForwardFixture();
    const result = run(f, { env: { CNB_TOKEN: undefined, HTTP_PROXY: undefined, HTTPS_PROXY: undefined } });
    pass(result);
    assert.ok(result.output.includes(f.source.slice(0, 12)), "source custom merge remains subject to the actual gate");
    assert.ok(!result.output.includes(oldInvalid), "target-only history is still excluded");
    assert.match(result.output, new RegExp(f.target + "\\.\\." + f.source));
  });
  it("accepts an exact explicit PR range for the same proven fast-forward checkout", () => {
    const f = fastForwardFixture();
    pass(run(f, { args: ["--range", f.target + ".." + f.source] }));
  });
  it("still rejects an invalid introduced nonmerge commit after a valid fast-forward custom source merge", () => {
    const f = fastForwardFixture({ sourceSubject: invalid });
    refuse(run(f), "任务号");
  });
  it("still rejects an invalid actual fast-forward source merge title", () => {
    const f = fastForwardFixture({ sourceMergeSubject: invalid });
    refuse(run(f), "任务号");
  });
  it("refuses fast-forward source HEAD with missing canonical merge metadata", () => {
    const f = fastForwardFixture();
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: undefined } }), "PR_MERGE_SHA_REQUIRED");
  });
  it("refuses fast-forward source HEAD with blank canonical merge metadata", () => {
    const f = fastForwardFixture();
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: " " } }), "PR_MERGE_SHA_INVALID");
  });
  it("refuses a missing canonical merge object without doing any network fallback", () => {
    const f = fastForwardFixture();
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: "a".repeat(40) } }), "PR_MERGE_COMMIT_UNAVAILABLE");
  });
  it("refuses a tree object as a canonical merge proof", () => {
    const f = fastForwardFixture();
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: f.git("rev-parse", f.merge + "^{tree}") } }), "PR_MERGE_COMMIT_UNAVAILABLE");
  });
  it("refuses the source's own integration commit as a substituted canonical merge proof", () => {
    const f = fastForwardFixture();
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: f.source } }), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("refuses reversed canonical merge parents even with identical content", () => {
    const f = fastForwardFixture();
    const merge = mergeProof(f, { parents: [f.source, f.target] });
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: merge } }), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("refuses a canonical proof commit with only one parent", () => {
    const f = fastForwardFixture();
    const merge = mergeProof(f, { parents: [f.source] });
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: merge } }), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("refuses changed canonical merge content even when target is an actual source ancestor", () => {
    const f = fastForwardFixture();
    const merge = mergeProof(f, { tree: alteredTree(f) });
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: merge } }), "PR_CHECKOUT_TREE_MISMATCH");
  });
  it("refuses source-only checkout when real diverged target changes are not in source", () => {
    const f = fixture();
    f.git("checkout", "--detach", f.source);
    refuse(run(f), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("refuses a forged same-tree merge proof for a source that does not descend from target", () => {
    const f = fixture();
    f.git("checkout", "--detach", f.source);
    const merge = mergeProof(f, { tree: f.git("rev-parse", f.source + "^{tree}") });
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: merge } }), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("refuses an unrelated empty child after proven source HEAD even with the exact same tree", () => {
    const f = fastForwardFixture();
    f.git("commit", "--allow-empty", "-m", valid);
    assert.equal(f.git("rev-parse", "HEAD^{tree}"), f.git("rev-parse", f.source + "^{tree}"));
    refuse(run(f), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("accepts a local two-parent merge with a different commit hash only when canonical tree and parents agree", () => {
    const f = fixture();
    const local = mergeProof(f, { message: "Local runner-generated merge subject is not a source commit" });
    assert.notEqual(local, f.merge);
    f.git("checkout", "--detach", local);
    const result = run(f);
    pass(result);
    assert.ok(result.output.includes(f.source.slice(0, 12)));
    assert.ok(!result.output.includes(local.slice(0, 12)), "runner wrapper does not receive source-commit validation");
  });
  it("refuses a local two-parent merge whose tree differs from canonical merged content", () => {
    const f = fixture();
    const local = mergeProof(f, { tree: alteredTree(f) });
    f.git("checkout", "--detach", local);
    refuse(run(f), "PR_CHECKOUT_TREE_MISMATCH");
  });
  it("refuses reversed local merge parents even when canonical content agrees", () => {
    const f = fixture();
    const local = mergeProof(f, { parents: [f.source, f.target] });
    f.git("checkout", "--detach", local);
    refuse(run(f), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("refuses a local octopus wrapper even when canonical content agrees", () => {
    const f = fixture();
    const local = mergeProof(f, { parents: [f.target, f.source, f.base] });
    f.git("checkout", "--detach", local);
    refuse(run(f), "PR_CHECKOUT_BINDING_MISMATCH");
  });
  it("refuses a canonical octopus proof for an otherwise valid fast-forward source checkout", () => {
    const f = fastForwardFixture();
    const merge = mergeProof(f, { parents: [f.target, f.source, f.base] });
    refuse(run(f, { env: { CNB_PULL_REQUEST_MERGE_SHA: merge } }), "PR_CHECKOUT_BINDING_MISMATCH");
  });
});

describe("CNB generated merge titles bind the exact real Git object", () => {
  function canonical(f, { parents = [f.target, f.source], subject = `Merged ${f.source} into ${f.target}` } = {}) {
    const head = mergeProof(f, { parents, message: subject });
    f.git("checkout", "--detach", head);
    return head;
  }
  function rejected(f) {
    const result = run(f, { pr: false });
    assert.notEqual(result.status, 0, result.output);
    return result;
  }
  it("accepts the observed full-SHA title only when the two actual parents match in order", () => {
    const f = fixture({ legacyTarget: false });
    const head = canonical(f);
    const result = run(f, { pr: false, env: { CNB_BEFORE_SHA: f.target } });
    pass(result);
    assert.ok(result.output.includes(head.slice(0, 12)));
    assert.match(result.output, /豁免/);
    assert.ok(result.output.includes(f.source.slice(0, 12)), "introduced source commits remain checked");
  });
  it("does not exempt a newly introduced invalid source commit behind the canonical merge", () => {
    const f = fixture({ legacyTarget: false, sourceSubject: invalid });
    canonical(f);
    const result = run(f, { pr: false, env: { CNB_BEFORE_SHA: f.target } });
    refuse(result, "任务号");
    assert.ok(result.output.includes(f.source.slice(0, 12)));
  });
  it("rejects an ordinary single-parent commit with the full canonical-looking title", () => {
    const f = fixture({ legacyTarget: false });
    canonical(f, { parents: [f.target] });
    rejected(f);
  });
  it("rejects a root commit with a canonical-looking title and no parents", () => {
    const f = fixture({ legacyTarget: false });
    canonical(f, { parents: [] });
    rejected(f);
  });
  it("rejects reversed actual parent order", () => {
    const f = fixture({ legacyTarget: false });
    canonical(f, { parents: [f.source, f.target] });
    rejected(f);
  });
  it("rejects full source SHA text that names a different existing commit", () => {
    const f = fixture({ legacyTarget: false });
    canonical(f, { subject: `Merged ${f.base} into ${f.target}` });
    rejected(f);
  });
  it("rejects full target SHA text that names a different existing commit", () => {
    const f = fixture({ legacyTarget: false });
    canonical(f, { subject: `Merged ${f.source} into ${f.base}` });
    rejected(f);
  });
  it("rejects an octopus merge even when the two named parents are present", () => {
    const f = fixture({ legacyTarget: false });
    canonical(f, { parents: [f.target, f.source, f.base] });
    rejected(f);
  });
  for (const [label, change] of [
    ["abbreviated SHAs", (s, t) => `Merged ${s.slice(0, 12)} into ${t.slice(0, 12)}`],
    ["zero SHA", (_s, t) => `Merged ${"0".repeat(40)} into ${t}`],
    ["extra words", (s, t) => `Merged ${s} into ${t} unchecked`],
    ["trailing space", (s, t) => `Merged ${s} into ${t} `],
    ["trailing tab", (s, t) => `Merged ${s} into ${t}\t`],
    ["leading space", (s, t) => ` Merged ${s} into ${t}`],
  ]) it("rejects a non-exact raw title: " + label, () => {
    const f = fixture({ legacyTarget: false });
    canonical(f, { subject: change(f.source, f.target) });
    rejected(f);
  });
  for (const label of ["duplicate parents", "unavailable parent", "noncommit parent"]) {
    it("rejects raw object header evidence with " + label, () => {
      const f = fixture({ legacyTarget: false });
      const source = label === "duplicate parents" ? f.target
        : label === "unavailable parent" ? "a".repeat(40)
        : f.git("rev-parse", f.source + "^{tree}");
      const tree = f.git("rev-parse", f.merge + "^{tree}");
      const raw = `tree ${tree}\nparent ${f.target}\nparent ${source}\n`
        + "author Fixture <fixture@example.invalid> 1791194400 +0800\n"
        + "committer Fixture <fixture@example.invalid> 1791194400 +0800\n\n"
        + `Merged ${source} into ${f.target}\n`;
      const path = join(f.root, "raw-merge-object.txt");
      writeFileSync(path, raw);
      const head = f.git("hash-object", "-w", "-t", "commit", path);
      assert.equal(f.git("cat-file", "-t", head), "commit");
      const result = run(f, { pr: false, args: ["--range", head] });
      assert.notEqual(result.status, 0, result.output);
    });
  }
  it("does not let git replace forge the original object's parent evidence", () => {
    const f = fixture({ legacyTarget: false });
    const subject = `Merged ${f.source} into ${f.target}`;
    const actual = canonical(f, { parents: [f.target], subject });
    const replacement = mergeProof(f, { parents: [f.target, f.source], message: subject });
    f.git("replace", actual, replacement);
    assert.equal(f.git("show", "-s", "--format=%P", actual), `${f.target} ${f.source}`);
    rejected(f);
  });
});

describe("push and manual checks preserve strict new-commit rules without history fallbacks", () => {
  it("checks all introduced commits in the actual before..HEAD push range", () => {
    const f = fixture({ sourceSubject: invalid, legacyTarget: false });
    f.git("checkout", "--detach", f.previousSource);
    const head = f.commit(valid, "latest-valid.txt");
    const result = run(f, { pr: false, env: { CNB_BEFORE_SHA: f.base, CNB_COMMIT: head } });
    refuse(result, "任务号");
    assert.ok(result.output.includes(f.previousSource.slice(0, 12)));
  });
  it("keeps already merged invalid history outside a valid push's before..HEAD", () => {
    const f = fixture();
    f.git("checkout", "--detach", f.target);
    f.commit(valid, "push-valid.txt");
    pass(run(f, { pr: false, env: { CNB_BEFORE_SHA: f.target } }));
  });
  for (const [label, before] of [["missing", undefined], ["blank", ""], ["zero", "0".repeat(40)]]) {
    it("checks only the actual single tip for a " + label + " initial push before", () => {
      const f = fixture();
      f.git("checkout", "--detach", f.target);
      const head = f.commit(valid, "first-push.txt");
      const result = run(f, { pr: false, env: { CNB_BEFORE_SHA: before } });
      pass(result);
      assert.ok(result.output.includes(head.slice(0, 12)));
      assert.ok(!result.output.includes(oldInvalid));
      assert.match(result.output, /1 条/);
    });
  }
  it("rejects an invalid actual single tip when the initial push before is absent", () => {
    const f = fixture({ legacyTarget: false });
    f.git("checkout", "--detach", f.target);
    f.commit(invalid, "initial-invalid.txt");
    refuse(run(f, { pr: false }), "任务号");
  });
  it("validates a custom merge tip on initial push rather than skipping it", () => {
    const f = fixture({ sourceMergeSubject: invalid, legacyTarget: false });
    f.git("checkout", "--detach", f.source);
    refuse(run(f, { pr: false, env: { CNB_BEFORE_SHA: "0".repeat(40) } }), "任务号");
  });
  for (const [label, before, code] of [
    ["unknown", "a".repeat(40), "PUSH_BEFORE_COMMIT_UNAVAILABLE"],
    ["abbreviated", "1234567", "PUSH_BEFORE_SHA_INVALID"],
    ["nonhex", "q".repeat(40), "PUSH_BEFORE_SHA_INVALID"],
    ["revision injection", "--all", "PUSH_BEFORE_SHA_INVALID"],
  ]) it("fails on " + label + " push before instead of falling back to a valid current HEAD", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { pr: false, env: { CNB_BEFORE_SHA: before } }), code);
  });
  it("rejects an existing noncommit push before object", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { pr: false, env: { CNB_BEFORE_SHA: f.git("rev-parse", f.base + "^{tree}") } }), "PUSH_BEFORE_COMMIT_UNAVAILABLE");
  });
  it("fails a push with no introduced commit rather than reporting an empty green check", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { pr: false, env: { CNB_BEFORE_SHA: f.merge } }), "PUSH_SOURCE_RANGE_EMPTY");
  });
  it("allows an explicit local range for a manual check while excluding target-only history", () => {
    const f = fixture();
    pass(run(f, { pr: false, env: { CNB_EVENT: undefined }, args: ["--range", f.target + ".." + f.source] }));
  });
  it("fails an unavailable explicit Git range with a named reason", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { pr: false, args: ["--range", "missing-ref..HEAD"] }), "EXPLICIT_RANGE_UNAVAILABLE");
  });
  it("fails an explicit empty range rather than reporting no commits as pass", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { pr: false, args: ["--range", f.source + ".." + f.source] }), "EXPLICIT_SOURCE_RANGE_EMPTY");
  });
  it("checks a manual single ref as one actual tip rather than scanning already merged history", () => {
    const f = fixture();
    f.git("checkout", "--detach", f.target);
    const result = run(f, { pr: false, args: ["--range", "HEAD"] });
    pass(result);
    assert.match(result.output, /1 条/);
  });
  for (const range of ["--all", "main...source", "HEAD:source.txt"]) {
    it("refuses explicit revision options or path expressions: " + range, () => {
      const f = fixture({ legacyTarget: false });
      refuse(run(f, { pr: false, args: ["--range", range] }), "EXPLICIT_RANGE_UNAVAILABLE");
    });
  }
  it("rejects --range with no argument", () => {
    const f = fixture({ legacyTarget: false });
    refuse(run(f, { pr: false, args: ["--range"] }), "EXPLICIT_RANGE_UNAVAILABLE");
  });
  it("refuses incomplete push history when an existing before tip is present", () => {
    const f = fixture({ legacyTarget: false });
    const shallow = shallowFixture(f);
    refuse(run(shallow, { pr: false, env: { CNB_BEFORE_SHA: f.target } }), "PUSH_HISTORY_INCOMPLETE");
  });
  it("keeps the existing self-test runnable outside a Git checkout", () => {
    const f = fixture();
    const result = spawnSync(process.execPath, [verifier, "--self-test"], {
      cwd: tmpdir(), encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 15_000,
    });
    assert.ifError(result.error);
    pass({ ...result, output: result.stdout + result.stderr });
    assert.match(result.stdout, /11 例/);
  });
});
