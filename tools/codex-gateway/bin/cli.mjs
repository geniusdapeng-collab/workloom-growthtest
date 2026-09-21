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
import { DEFAULT_STAGE_PORT, buildSnapshot, shortContext } from "../src/snapshot.mjs";
import { runMcpStdio } from "../src/mcp.mjs";
import { startGateway } from "../src/server.mjs";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand] = args._;
  const cwd = String(args.cwd ?? process.env.WORKLOOM_SESSION_CWD ?? process.cwd());
  const repoRoot = resolveRepoRoot(cwd);

  if (!command || command === "help" || command === "--help") {
    console.log("workloom-gateway：catalog | stage | doctor | context | mcp");
    return 0;
  }

  if (command === "mcp") {
    runMcpStdio({ repoRoot });
    return 0;
  }

  const catalog = generateCatalog({ repoRoot });

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
    const snapshot = buildSnapshot({ repoRoot, catalog });
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
    const snapshot = buildSnapshot({ repoRoot, catalog });
    const additionalContext = shortContext(snapshot);
    console.log(JSON.stringify({ additionalContext, systemMessage: `WorkLoom 工作台已就绪：${snapshot.counts.agents} 个数字员工，${snapshot.counts.pendingApprovals} 项待审批（${snapshot.dataMode}）` }, null, 2));
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
    if (typeof code === "number") process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
