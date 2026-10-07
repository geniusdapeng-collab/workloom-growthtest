/** Evidence runs may change; the budget for the same output directory must remain cumulative. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const schemaVersion = "workloom.live-budget-run/v1";
const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$/.test(value);
function ordinary(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 10 * 1024 * 1024) throw new Error("累计预算身份/账本必须是独立普通文件");
}

export function loadBudgetRunIdentity({ outDir, environmentKind }) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "budget-run.json"), ledger = join(outDir, "budget-ledger.jsonl");
  let legacyId = null;
  if (existsSync(ledger)) {
    ordinary(ledger);
    const text = readFileSync(ledger, "utf8");
    if (text && !text.endsWith("\n")) throw new Error("旧预算账本末行缺少换行；需对账，禁止创建身份或继续付费调用");
    const rows = text.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const ids = [...new Set(rows.map(row => row.runId))];
    if (ids.length !== 1 || !validId(ids[0])) throw new Error("旧预算包含多个或缺失运行身份；需对账，禁止创建空预算重新付费");
    legacyId = ids[0];
  }
  if (!existsSync(file)) {
    const identity = { schemaVersion, runId: legacyId ?? `live-${randomUUID()}`, environmentKind, createdAt: new Date().toISOString() };
    try { writeFileSync(file, JSON.stringify(identity) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  ordinary(file);
  const identity = JSON.parse(readFileSync(file, "utf8"));
  if (identity?.schemaVersion !== schemaVersion || !validId(identity.runId) || identity.environmentKind !== environmentKind
    || !Number.isFinite(Date.parse(identity.createdAt)) || legacyId && legacyId !== identity.runId) throw new Error("累计预算身份与原账本/目标环境不一致；禁止重置额度");
  return identity.runId;
}
