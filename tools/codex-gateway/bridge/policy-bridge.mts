/**
 * 策略桥（P1）：把仓内真实围栏/审批纯函数暴露给零依赖网关。
 *
 * 为什么需要桥：
 *  - 网关是零依赖 Node ESM（tools/ 不在 pnpm workspace），不能直接 import TypeScript 包；
 *  - 但围栏语义与手势校验必须复用 packages/base 的真实实现，禁止在网关里重写。
 * 因此用 `tsx` 起一个常驻子进程，JSON-lines 协议调用：
 *   {"id":1,"method":"judge","params":{"input":{...}}}      → judge(input, rules, defaultLevel)
 *   {"id":2,"method":"gesture","params":{"gesture":{...},"role":"owner"}}
 *   {"id":3,"method":"validateEvent","params":{"event":{...}}}
 *   {"id":4,"method":"packs"}
 *   {"id":5,"method":"ping"}
 *
 * 规则装载：读取 bundles/<bundle>/fences/*.yml，全部装载为 active 规则集。
 * P1 实验口径：多包规则取并集（deny 优先由 judge 内部实现，天然取严）；
 * 生产应由服务端按 workspace 维度下发 active 规则，本桥只是实验适配器。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import YAML from "yaml";
import { fenceRulesOf, judge, type FenceLevel, type JudgeInput, type RuntimeRule } from "@workloom/base/fence-engine";
import { registerWriteActions } from "@workloom/base/workdata";
import { assertApproverRole, validateGesture, ApprovalError, type GestureInput } from "@workloom/base/review-console";
import { parseBusinessEvent } from "@workloom/shared";

const repoRoot = process.env.WORKLOOM_REPO_ROOT ?? process.cwd();

function listFiles(dir: string, suffix: string): string[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(suffix))
      .sort();
  } catch {
    return [];
  }
}

const packs: Array<{ file: string; version: string; defaultLevel: FenceLevel; rules: RuntimeRule[] }> = [];
const rules: RuntimeRule[] = [];

/**
 * 与 apps/server/src/trpc/router.ts 的获客线装载口径一致：
 * G 号 / G-GEO 号规则不走 loadFencePack 的 R\d+ zod 严格 DSL，而是裸 YAML +
 * fenceRulesOf 物化到 RuntimeRule。字段形状三域一致，缺失即抛（fail-closed）。
 */
function loadGrowthFencePack(yamlText: string, file: string): { version: string; defaultLevel: FenceLevel; rules: RuntimeRule[] } {
  const raw = YAML.parse(yamlText) as { version?: string; default_level?: FenceLevel; rules?: unknown; fences?: unknown };
  const list = fenceRulesOf(raw);
  if (!list.length) throw new Error(`${file}: 围栏包未解析出规则`);
  const mapped = list.map((rule) => {
    const ruleId = String(rule.rule_id ?? "");
    const match = (rule.match ?? {}) as { object_types?: unknown; actions?: unknown };
    const objectTypes = Array.isArray(match.object_types) ? match.object_types.map(String) : [];
    const actions = Array.isArray(match.actions) ? match.actions.map(String) : [];
    const level = String(rule.level ?? "");
    if (!ruleId || !objectTypes.length || !actions.length || !["auto", "review", "block"].includes(level)) {
      throw new Error(`${file}: 规则 ${ruleId || "(无 id)"} 字段不完整`);
    }
    return {
      rule_id: ruleId,
      version: String(raw.version ?? ""),
      name: String(rule.name ?? ruleId),
      level: level as FenceLevel,
      is_baseline: rule.is_baseline !== false,
      objectTypes,
      actions,
      when: String(rule.when ?? ""),
    } satisfies RuntimeRule;
  });
  return { version: String(raw.version ?? ""), defaultLevel: (raw.default_level ?? "review") as FenceLevel, rules: mapped };
}

const bundlesDir = join(repoRoot, "bundles");
for (const bundle of (() => {
  try {
    return readdirSync(bundlesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
})()) {
  const fenceDir = join(bundlesDir, bundle, "fences");
  for (const file of listFiles(fenceDir, ".yml")) {
    const rel = `bundles/${bundle}/fences/${file}`;
    const loaded = loadGrowthFencePack(readFileSync(join(fenceDir, file), "utf8"), rel);
    packs.push({ file: rel, version: loaded.version, defaultLevel: loaded.defaultLevel, rules: loaded.rules });
    rules.push(...loaded.rules);
  }
}

// 并集去重：同 rule_id 以最后一次装载为准（P1 实验；生产按 workspace active 规则装载）。
const byRuleId = new Map<string, RuntimeRule>();
for (const rule of rules) byRuleId.set(rule.rule_id, rule);
const activeRules = [...byRuleId.values()];
const defaultLevel: FenceLevel = packs.some((pack) => pack.defaultLevel === "review") ? "review" : "auto";
registerWriteActions(activeRules.flatMap((rule) => rule.actions));

function reply(id: unknown, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id: unknown, code: number, message: string) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handle(message: { id?: unknown; method?: string; params?: Record<string, unknown> }) {
  const { id, method, params = {} } = message;
  try {
    switch (method) {
      case "ping":
        reply(id, { ok: true, rules: activeRules.length, packs: packs.length });
        return;
      case "packs":
        reply(id, { defaultLevel, packs: packs.map((pack) => ({ file: pack.file, version: pack.version, defaultLevel: pack.defaultLevel, rules: pack.rules.length })), activeRules: activeRules.length });
        return;
      case "judge": {
        const input = (params.input ?? {}) as JudgeInput;
        const verdict = judge(input, activeRules, defaultLevel);
        reply(id, verdict);
        return;
      }
      case "gesture": {
        const role = String(params.role ?? "owner") as Parameters<typeof assertApproverRole>[0];
        assertApproverRole(role);
        validateGesture((params.gesture ?? {}) as GestureInput);
        reply(id, { ok: true });
        return;
      }
      case "validateEvent": {
        const event = parseBusinessEvent(params.event ?? {});
        reply(id, { ok: true, eventId: event.event_id });
        return;
      }
      default:
        replyError(id, -32601, `method not found: ${String(method)}`);
    }
  } catch (error) {
    if (error instanceof ApprovalError) {
      replyError(id, -32010, `${error.code}: ${error.message}`);
      return;
    }
    replyError(id, -32000, error instanceof Error ? error.message : String(error));
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    void handle(JSON.parse(trimmed));
  } catch {
    // 忽略非 JSON 行
  }
});

process.stderr.write(`workloom policy bridge 已启动：${packs.length} 个围栏包 / ${activeRules.length} 条 active 规则 / default_level=${defaultLevel}\n`);
