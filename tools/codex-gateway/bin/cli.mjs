#!/usr/bin/env node
/**
 * workloom-gateway CLI（P0，只读）。
 *
 *   node bin/cli.mjs catalog list [--json] [--domain x] [--kind y] [--limit N]
 *   node bin/cli.mjs catalog describe <id> [--json]
 *   node bin/cli.mjs stage snapshot [--json]
 *   node bin/cli.mjs stage serve [--port N] [--host 127.0.0.1]
 *   node bin/cli.mjs doctor [--json]
 *   node bin/cli.mjs context [--cwd DIR]     # 供 Codex hook 使用
 *   node bin/cli.mjs mcp
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gatewayRoot, resolveRepoRoot } from "../src/paths.mjs";
import { findCapability, generateCatalog, searchCapabilities } from "../src/catalog.mjs";
import { DEFAULT_STAGE_PORT, buildProjection, shortContext } from "../src/snapshot.mjs";
import { runMcpStdio } from "../src/mcp.mjs";
import { startGateway } from "../src/server.mjs";
import { createRunService } from "../src/runs.mjs";
import { createLiveSource } from "../src/live-source.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function printHumanCapability(capability) {
  const risk = capability.risk?.level ?? "auto";
  const key = capability.presetKey ?? capability.skillKey ?? capability.pipelineKey ?? capability.ruleId ?? "";
  console.log(`${capability.id}\t[${capability.kind}/${risk}]\t${capability.displayName}\t${key}`);
  if (capability.summary) console.log(`  ${capability.summary}`);
}

function parseJsonArg(value, label) {
  if (value === undefined || value === true) return undefined;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

/** 当前进程内已创建的服务：统一在退出前关闭策略桥，避免子进程持有管道导致 CLI 无法退出。 */
let activeService = null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand] = args._;
  const cwd = String(args.cwd ?? process.env.WORKLOOM_SESSION_CWD ?? process.cwd());
  const repoRoot = resolveRepoRoot(cwd);

  if (!command || command === "help" || command === "--help") {
    console.log("workloom-gateway：catalog | stage | run | approval | ledger | audit | doctor | context | mcp");
    return 0;
  }

  if (command === "mcp") {
    runMcpStdio({ repoRoot });
    return 0;
  }

  const catalog = generateCatalog({ repoRoot });
  const service = command === "run" || command === "approval" || command === "ledger" || command === "audit" || command === "doctor"
    ? createRunService({ repoRoot, catalog })
    : null;
  activeService = service;

  if (command === "catalog" && subcommand === "list") {
    const capabilities = searchCapabilities(catalog, {
      query: String(args.q ?? ""),
      domain: String(args.domain ?? ""),
      kind: String(args.kind ?? ""),
      limit: Number(args.limit ?? 50),
    });
    if (args.json) {
      console.log(JSON.stringify({ summary: catalog.summary, count: capabilities.length, capabilities }, null, 2));
    } else {
      console.log(`${catalog.repo.displayName || catalog.repo.name} · ${catalog.summary.bundles} bundles / ${catalog.summary.employees} 员工 / ${catalog.summary.skills} 技能 / ${catalog.summary.pipelines} 管线 / ${catalog.summary.fences} 围栏`);
      for (const capability of capabilities) printHumanCapability(capability);
    }
    return 0;
  }

  if (command === "catalog" && subcommand === "describe") {
    const id = args._[2] ?? args.id;
    const capability = findCapability(catalog, id);
    if (!capability) {
      console.error(`未找到能力：${id ?? "(空)"}`);
      return 2;
    }
    console.log(args.json ? JSON.stringify(capability, null, 2) : JSON.stringify(capability, null, 2));
    return 0;
  }

  if (command === "stage" && subcommand === "snapshot") {
    const snapshotService = createRunService({ repoRoot, catalog });
    const snapshot = await buildProjection({ repoRoot, catalog, store: snapshotService.store, liveSource: createLiveSource() });
    snapshotService.close();
    console.log(JSON.stringify(snapshot, null, 2));
    return 0;
  }

  if (command === "stage" && subcommand === "serve") {
    const port = Number(args.port ?? process.env.WORKLOOM_GATEWAY_PORT ?? DEFAULT_STAGE_PORT);
    const host = String(args.host ?? process.env.WORKLOOM_GATEWAY_HOST ?? "127.0.0.1");
    const instance = await startGateway({ port, host, repoRoot });
    console.log(`WorkLoom Codex 网关已启动：${instance.url}`);
    console.log(`数字人工作台（只读 / 模拟数据）：${instance.stageUrl}`);
    console.log("按 Ctrl+C 退出。");
    const shutdown = async () => {
      await instance.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return new Promise(() => {});
  }

  if (command === "context") {
    const contextService = createRunService({ repoRoot, catalog });
    const snapshot = await buildProjection({ repoRoot, catalog, store: contextService.store, liveSource: createLiveSource() });
    contextService.close();
    const additionalContext = shortContext(snapshot);
    console.log(JSON.stringify({ additionalContext, systemMessage: `WorkLoom 工作台已就绪：${snapshot.counts.agents} 个数字员工，${snapshot.counts.pendingApprovals} 项待审批（${snapshot.dataMode}）` }, null, 2));
    return 0;
  }

  if (command === "run" && subcommand === "start") {
    const capabilityId = args._[2] ?? args.capability;
    const result = await service.startRun({
      capabilityId,
      params: parseJsonArg(args.params, "--params") ?? {},
      action: args.action,
      objectType: args["object-type"],
      objectId: args["object-id"],
      effect: args.effect,
      context: parseJsonArg(args.context, "--context") ?? {},
      idempotencyKey: args["idempotency-key"],
    });
    console.log(JSON.stringify(result, null, 2));
    service.close();
    return result.run?.state === "blocked" ? 3 : 0;
  }
  if (command === "run" && subcommand === "list") {
    console.log(JSON.stringify({ runs: service.listRuns() }, null, 2));
    service.close();
    return 0;
  }
  if (command === "run" && subcommand === "status") {
    const run = service.getRun(args._[2] ?? args.runId);
    if (!run) {
      console.error(`未找到 Run：${args._[2] ?? "(空)"}`);
      service.close();
      return 2;
    }
    console.log(JSON.stringify(run, null, 2));
    service.close();
    return 0;
  }
  if (command === "run" && subcommand === "tail") {
    console.log(JSON.stringify({ runId: args._[2] ?? args.runId, events: service.tailRun(args._[2] ?? args.runId, Number(args.limit ?? 50)) }, null, 2));
    service.close();
    return 0;
  }
  if (command === "run" && subcommand === "cancel") {
    const result = service.cancelRun({ runId: args._[2] ?? args.runId, reason: args.reason });
    console.log(JSON.stringify(result, null, 2));
    service.close();
    return 0;
  }
  if (command === "approval" && subcommand === "list") {
    console.log(JSON.stringify({ approvals: service.listApprovals({ status: args.status }) }, null, 2));
    service.close();
    return 0;
  }
  if (command === "approval" && subcommand === "decide") {
    const result = await service.decideApproval({
      approvalId: args._[2] ?? args.approvalId,
      gesture: {
        type: args.gesture,
        reasonEnum: args["reason-enum"],
        reasonText: args["reason-text"],
        editedAfter: parseJsonArg(args["edited-after"], "--edited-after"),
      },
      role: args.role ?? "owner",
    });
    console.log(JSON.stringify(result, null, 2));
    service.close();
    return 0;
  }
  if (command === "ledger" && subcommand === "verify") {
    const result = service.verifyLedger();
    console.log(JSON.stringify(result, null, 2));
    service.close();
    return result.ok ? 0 : 1;
  }
  if (command === "ledger" && subcommand === "tail") {
    console.log(JSON.stringify({ events: service.store.listLedger({ since: args.since }).slice(-Number(args.limit ?? 20)) }, null, 2));
    service.close();
    return 0;
  }
  if (command === "audit") {
    const raw = await readStdin();
    let payload = {};
    try {
      payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      payload = { raw: raw.slice(0, 2000), parseError: true };
    }
    const eventName = String(payload.hook_event_name ?? args.source ?? "codex-hook");
    const event = service.store.appendLedger({
      who: { type: "system", id: "codex-hooks", version: "p1" },
      context: {
        tenant_id: "growthtest",
        workspace_id: catalog.repo.defaultBundle || "geo-growth",
        time: new Date().toISOString(),
        channel: "codex-hook",
      },
      object: { type: "codex_event", id: String(payload.session_id ?? payload.turn_id ?? eventName) },
      decision: { action: `codex.${eventName}`, after: { tool: payload.tool_name, cwd: payload.cwd } },
      rule_impact: [],
    });
    console.log(JSON.stringify({ ok: true, eventId: event.event_id, action: event.decision.action }));
    service.close();
    return 0;
  }

  if (command === "doctor") {
    const checks = [];
    const major = Number(process.versions.node.split(".")[0]);
    checks.push({ name: "node>=24", ok: major >= 24, detail: process.version });
    checks.push({ name: "repo-root", ok: existsSync(join(repoRoot, "product.manifest.json")), detail: repoRoot });
    checks.push({ name: "bundles", ok: catalog.summary.bundles > 0, detail: `${catalog.summary.bundles}` });
    checks.push({ name: "catalog-capabilities", ok: catalog.capabilities.length > 0, detail: `${catalog.capabilities.length}` });
    checks.push({ name: "catalog-warnings", ok: catalog.warnings.length === 0, detail: `${catalog.warnings.length}` });
    checks.push({ name: "fixtures", ok: existsSync(gatewayRoot("fixtures", "mock-state.json")), detail: "fixtures/mock-state.json" });
    checks.push({ name: "stage-page", ok: existsSync(gatewayRoot("stage", "index.html")), detail: "stage/index.html" });
    checks.push({ name: "plugin-manifest", ok: existsSync(join(repoRoot, "plugins", "workloom-workbench", ".codex-plugin", "plugin.json")), detail: "plugins/workloom-workbench" });
    checks.push({ name: "plugin-marketplace", ok: existsSync(join(repoRoot, ".agents", "plugins", "marketplace.json")), detail: ".agents/plugins/marketplace.json" });
    let policyOk = false;
    let policyDetail = "unavailable";
    try {
      const packs = await service.policy.packs();
      policyOk = packs.activeRules > 0;
      policyDetail = `${packs.packs.length} 包 / ${packs.activeRules} 规则`;
    } catch (error) {
      policyDetail = error instanceof Error ? error.message : String(error);
    }
    checks.push({ name: "policy-bridge", ok: policyOk, detail: policyDetail });
    const ledger = service.verifyLedger();
    checks.push({ name: "ledger-chain", ok: ledger.ok, detail: ledger.ok ? `${ledger.total} 条 / ${String(ledger.lastHash).slice(0, 12)}…` : `broken at ${ledger.brokenAt}` });
    const failed = checks.filter((check) => !check.ok);
    if (args.json) {
      console.log(JSON.stringify({ ok: failed.length === 0, checks, warnings: catalog.warnings, unparsed: catalog.unparsed }, null, 2));
    } else {
      for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}  ${check.detail}`);
      console.log(`\n能力目录：${catalog.summary.employees} 员工 / ${catalog.summary.skills} 技能 / ${catalog.summary.pipelines} 管线 / ${catalog.summary.fences} 围栏；告警 ${catalog.warnings.length}，未解析 ${catalog.unparsed.length}`);
    }
    return failed.length === 0 ? 0 : 1;
  }

  console.error(`未知命令：${[command, subcommand].filter(Boolean).join(" ")}`);
  return 2;
}

main()
  .then((code) => {
    activeService?.close();
    if (typeof code === "number") process.exitCode = code;
  })
  .catch((error) => {
    activeService?.close();
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
