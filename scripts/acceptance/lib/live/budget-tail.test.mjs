/** Corrupt ledger tails are local fixtures; no real provider or credential is used. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBudget } from "./budget.mjs";
import { loadBudgetRunIdentity } from "./live-budget-scope.mjs";

function fixture(t) {
  const outDir = mkdtempSync(join(tmpdir(), "wl-budget-tail-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const options = { outDir, runId: "synthetic-tail-run", environmentKind: "local-preview", budgets: {} };
  return { options, budget: createBudget(options) };
}

function incompleteTail(budget) {
  const text = readFileSync(budget.ledgerPath, "utf8"); assert.equal(text.endsWith("\n"), true);
  const broken = text.slice(0, -1); writeFileSync(budget.ledgerPath, broken); return broken;
}

test("budget tail: an unterminated valid JSON event cannot become a new cumulative identity", t => {
  const { options, budget } = fixture(t); const broken = incompleteTail(budget);
  assert.throws(() => loadBudgetRunIdentity(options), /末行.*换行/);
  assert.equal(readFileSync(budget.ledgerPath, "utf8"), broken);
});

test("budget tail: reopening an unterminated valid init stops without another ledger append", t => {
  const { options, budget } = fixture(t); const broken = incompleteTail(budget);
  assert.throws(() => createBudget(options), /末行.*换行/);
  assert.equal(readFileSync(budget.ledgerPath, "utf8"), broken);
});

test("budget tail: an active writer checks the current tail before authorizing a new external action", t => {
  const { budget } = fixture(t); const broken = incompleteTail(budget); let externalCalls = 0; let stopped;
  try {
    const gate = budget.reserve({ taskId: "IMG-NEXT", kind: "image", units: 1 });
    if (gate.allowed) externalCalls += 1;
  } catch (error) { stopped = error; }
  assert.equal(externalCalls, 0); assert.match(stopped?.message ?? "", /末行.*换行/); assert.equal(readFileSync(budget.ledgerPath, "utf8"), broken);
});

test("budget tail: a complete persisted ledger can reopen and reserve a different task within the original allowance", t => {
  const { options, budget } = fixture(t);
  assert.equal(budget.reserve({ taskId: "IMG-FIRST", kind: "image", units: 1 }).allowed, true);
  budget.commit({ taskId: "IMG-FIRST", kind: "image", units: 1, measured: true });
  const reopened = createBudget(options); assert.equal(reopened.reserve({ taskId: "IMG-NEXT", kind: "image", units: 1 }).allowed, true);
  assert.equal(reopened.summary().actual.images, 1); assert.equal(reopened.summary().pending.images, 1);
});
