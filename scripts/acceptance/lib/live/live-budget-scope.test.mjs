/** Only local synthetic budget events; no provider calls. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBudget } from "./budget.mjs";
import { loadBudgetRunIdentity } from "./live-budget-scope.mjs";

const fixture = t => { const outDir = mkdtempSync(join(tmpdir(), "wl-budget-scope-")); t.after(() => rmSync(outDir, { recursive: true, force: true })); return { outDir, environmentKind: "local-preview" }; };
test("restart reuses the original budget, keeps settlement bytes and cannot gain another image allowance", t => {
  const f = fixture(t), runId = loadBudgetRunIdentity(f);
  const first = createBudget({ ...f, runId, budgets: { maxImages: 1 } });
  assert.equal(first.reserve({ taskId: "IMG-01", kind: "image", units: 1 }).allowed, true);
  first.commit({ taskId: "IMG-01", kind: "image", units: 1, measured: true });
  const text = readFileSync(first.ledgerPath, "utf8");
  const reopened = createBudget({ ...f, runId: loadBudgetRunIdentity(f), budgets: { maxImages: 1 } });
  assert.equal(reopened.reserve({ taskId: "IMG-01", kind: "image", units: 1 }).settled, true);
  assert.equal(readFileSync(first.ledgerPath, "utf8"), text);
  assert.equal(reopened.reserve({ taskId: "IMG-02", kind: "image", units: 1 }).allowed, false);
  assert.equal(reopened.summary().actual.images, 1);
});
test("single historical budget identity is adopted without changing its ledger", t => {
  const f = fixture(t), first = createBudget({ ...f, runId: "legacy-run", budgets: {} });
  const text = readFileSync(first.ledgerPath, "utf8");
  assert.equal(loadBudgetRunIdentity(f), "legacy-run"); assert.equal(readFileSync(first.ledgerPath, "utf8"), text);
});
test("mixed/absent historical identities, malformed JSON, links and changed environment do not reset the budget", t => {
  for (const rows of [[{ runId: "one" }, { runId: "two" }], [{}], []]) {
    const f = fixture(t); writeFileSync(join(f.outDir, "budget-ledger.jsonl"), rows.map(row => JSON.stringify(row)).join("\n"));
    assert.throws(() => loadBudgetRunIdentity(f), /旧预算/);
  }
  const corrupt = fixture(t); writeFileSync(join(corrupt.outDir, "budget-run.json"), "broken"); assert.throws(() => loadBudgetRunIdentity(corrupt));
  const other = fixture(t); loadBudgetRunIdentity(other); assert.throws(() => loadBudgetRunIdentity({ ...other, environmentKind: "deployed" }), /不一致/);
  const linked = fixture(t); symlinkSync(join(other.outDir, "budget-run.json"), join(linked.outDir, "budget-run.json")); assert.throws(() => loadBudgetRunIdentity(linked), /普通文件/);
});
