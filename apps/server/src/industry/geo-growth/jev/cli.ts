#!/usr/bin/env node
/**
 * Jev 影子评估 CLI（growth 行业侧）
 *
 * 用法（仓库内，tsx 已在根 devDependencies）：
 *   pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts --scene comment-classify --dataset <file.jsonl>
 *   pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts --scene comment-classify --exam          # 内置考卷
 *   pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts --scene lead-qualify --mock              # 离线全链路
 *
 * 通道 2（默认，TypeSafe 官方直连）：
 *   TYPESAFE_API_KEY=<key> pnpm tsx .../cli.ts --scene comment-classify --dataset <file.jsonl>
 *
 * 通道 1（备选，Vercel AI Gateway）：
 *   JEV_PROVIDER=vercel-gateway AI_GATEWAY_API_KEY=<key> pnpm tsx .../cli.ts --scene comment-classify --dataset <file.jsonl>
 *
 * 通道判定：--provider > JEV_PROVIDER > 按键推断（TYPESAFE_API_KEY / AI_GATEWAY_API_KEY）> 默认直连。
 * 真 key 首次接入必须带 --capture-raw --limit 3，先钉死解析口径再全量跑。
 *
 * 纪律：只读评估；只写 --out 目录；数据集必须已脱敏（程序不落库、不外发消息）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GATEWAY_BASE_URL,
  JevClient,
  TYPESAFE_BASE_URL,
  apiKeyFromEnv,
  defaultBaseUrl,
  defaultModel,
  resolveProvider,
} from "./client.js";
import { startMockServer } from "./mock-gateway.js";
import { sceneOf } from "./scenes.js";
import { runShadow } from "./shadow.js";
import type { JevProvider, ShadowRow } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CliArgs {
  scene: string;
  provider: JevProvider;
  dataset: string | undefined;
  out: string | undefined;
  limit: number | undefined;
  concurrency: number;
  maxCostUsd: number;
  mock: boolean;
  captureRaw: boolean;
  exam: boolean;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  help: boolean;
}

/** 默认值在**调用时**求值（JEV_PROVIDER 非法时要报错而不是让 import 直接炸） */
export function defaultArgs(env: NodeJS.ProcessEnv = process.env): CliArgs {
  const provider = resolveProvider(env);
  return {
    scene: "comment-classify",
    provider,
    dataset: undefined,
    out: undefined,
    limit: undefined,
    concurrency: 4,
    maxCostUsd: 1,
    mock: false,
    captureRaw: false,
    exam: false,
    model: env["JEV_MODEL"] ?? defaultModel(provider),
    baseUrl: env["JEV_BASE_URL"] ?? defaultBaseUrl(provider),
    timeoutMs: env["JEV_TIMEOUT_MS"] ? Number(env["JEV_TIMEOUT_MS"]) : 20_000,
    help: false,
  };
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: CliArgs = { ...defaultArgs(env) };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`参数 ${token} 缺少取值`);
      return value;
    };
    switch (token) {
      case "--scene":
        args.scene = next();
        break;
      case "--provider": {
        const value = next().trim().toLowerCase();
        args.provider = resolveProvider({ JEV_PROVIDER: value });
        // 通道变了 → 未显式给出的 baseUrl/model 跟随通道默认值
        if (!argv.includes("--base-url")) args.baseUrl = defaultBaseUrl(args.provider);
        if (!argv.includes("--model")) args.model = env["JEV_MODEL"] ?? defaultModel(args.provider);
        break;
      }
      case "--dataset":
        args.dataset = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--limit":
        args.limit = Number(next());
        break;
      case "--concurrency":
        args.concurrency = Number(next());
        break;
      case "--max-cost-usd":
        args.maxCostUsd = Number(next());
        break;
      case "--model":
        args.model = next();
        break;
      case "--base-url":
        args.baseUrl = next();
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        break;
      case "--mock":
        args.mock = true;
        break;
      case "--capture-raw":
        args.captureRaw = true;
        break;
      case "--exam":
        args.exam = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`未知参数：${token}（--help 查看用法）`);
    }
  }
  return args;
}

export function parseJsonl(content: string, sourceName: string): ShadowRow[] {
  const rows: ShadowRow[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${sourceName} 第 ${index + 1} 行不是合法 JSON`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`${sourceName} 第 ${index + 1} 行不是对象`);
    }
    const row = parsed as Record<string, unknown>;
    const id = row["id"];
    const text = row["text"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`${sourceName} 第 ${index + 1} 行缺少 id`);
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(`${sourceName} 第 ${index + 1} 行缺少 text`);
    }
    const shadowRow: ShadowRow = { id, text };
    if (typeof row["expected"] === "string") shadowRow.expected = row["expected"];
    if (typeof row["context"] === "object" && row["context"] !== null) {
      shadowRow.context = row["context"] as Record<string, unknown>;
    }
    if (Array.isArray(row["officialClaims"])) {
      shadowRow.officialClaims = row["officialClaims"].filter(
        (item): item is string => typeof item === "string",
      );
    }
    rows.push(shadowRow);
  }
  return rows;
}

function helpText(): string {
  return [
    "Jev 影子评估 CLI（growth）",
    "",
    "  --scene <key>          comment-classify | lead-qualify | fact-precheck（默认 comment-classify）",
    "  --provider <kind>      typesafe（默认，官方直连 /v1/systemone）| vercel-gateway（evaluation v4）",
    "  --dataset <path>       JSONL 数据集（每行 {id, text, expected?, context?, officialClaims?}）",
    "  --exam                 使用随包的考卷（apps/server/src/industry/geo-growth/jev/exam/<scene>.jsonl）",
    "  --out <dir>            报告输出目录（默认 artifacts/jev-shadow/<时间戳>）",
    "  --limit <n>            只跑前 n 行",
    "  --concurrency <n>      并发（默认 4）",
    "  --max-cost-usd <n>     成本熔断阈值（默认 1 美元）",
    "  --mock                 使用本地模拟网关（离线；无 key 时的默认演练方式）",
    "  --capture-raw          保存原始响应（首次接真 key 时用来钉死解析口径）",
    `  --model <id>           默认 ${defaultModel("typesafe")}（直连）/ ${defaultModel("vercel-gateway")}（网关），或 JEV_MODEL`,
    `  --base-url <url>       默认 ${TYPESAFE_BASE_URL}（直连）/ ${GATEWAY_BASE_URL}（网关），或 JEV_BASE_URL`,
    "  --timeout-ms <n>       单次请求超时（默认 20000）",
    "",
    "环境变量：TYPESAFE_API_KEY（通道 2 必需）｜AI_GATEWAY_API_KEY（通道 1 必需）｜JEV_PROVIDER｜--mock 不需要 key",
  ].join("\n");
}

function defaultOutDir(scene: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // data/ 是本仓已 gitignore 的「本地数据（证据快照）」目录：评估结果只留本机，不进仓库
  return join(process.cwd(), "data", "jev-shadow", `${scene}-${stamp}`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (args.help) {
    console.log(helpText());
    return 0;
  }

  const scene = sceneOf(args.scene);
  const datasetPath = args.exam
    ? join(HERE, "exam", `${scene.key}.jsonl`)
    : args.dataset
      ? resolve(args.dataset)
      : undefined;
  if (!datasetPath) {
    console.error("缺少 --dataset（或使用 --exam 跑内置考卷）；--help 查看用法");
    return 2;
  }
  let rows: ShadowRow[];
  try {
    rows = parseJsonl(readFileSync(datasetPath, "utf8"), datasetPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (args.limit !== undefined && Number.isFinite(args.limit)) rows = rows.slice(0, Math.max(0, args.limit));
  if (rows.length === 0) {
    console.error("数据集为空");
    return 2;
  }

  const apiKey = apiKeyFromEnv(process.env, args.provider);
  const useMock = args.mock || !apiKey;
  if (!args.mock && !apiKey) {
    const keyName = args.provider === "typesafe" ? "TYPESAFE_API_KEY" : "AI_GATEWAY_API_KEY";
    console.error(
      [
        `未检测到 ${keyName}（当前通道：${args.provider}）。`,
        "  · 离线演练：加 --mock",
        "  · 通道 2（官方直连，默认）：在 console.typesafe.ai/keys 创建 key 后：",
        "      TYPESAFE_API_KEY=<key> pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts --scene <scene> --dataset <file>",
        "  · 通道 1（Vercel AI Gateway，--provider vercel-gateway）：",
        "      AI_GATEWAY_API_KEY=<key> pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts --scene <scene> --dataset <file>",
        "    key 只从环境注入，不要写进任何文件。",
      ].join("\n"),
    );
    return 2;
  }

  const mockServer = useMock ? await startMockServer({ failFirstRequests: 0 }) : undefined;
  const client = new JevClient({
    provider: args.provider,
    apiKey: useMock ? "mock" : apiKey,
    baseUrl: useMock ? (mockServer?.url ?? args.baseUrl) : args.baseUrl,
    model: args.model,
    timeoutMs: args.timeoutMs,
  });

  const outDir = resolve(args.out ?? defaultOutDir(scene.key));
  const mode = useMock
    ? `mock(${mockServer?.url ?? "in-process"}, shape=${args.provider})`
    : `${args.provider}(${client.host})`;
  console.log(`[jev-shadow] scene=${scene.key} rows=${rows.length} mode=${mode} model=${client.modelId}`);

  try {
    const { outcomes, report, raws } = await runShadow({
      rows,
      scene,
      client,
      concurrency: args.concurrency,
      maxCostUsd: args.maxCostUsd,
      captureRaw: args.captureRaw,
      onProgress: (done, total, outcome) => {
        const flag = outcome.error ? `ERROR ${outcome.error}` : `${outcome.decisionZh} conf=${outcome.confidence.toFixed(2)} route=${outcome.route}`;
        const mark = outcome.expected === undefined ? "" : outcome.correct ? " ✓" : " ✗";
        console.log(`  [${done}/${total}] ${outcome.id} → ${flag}${mark} (${outcome.latencyMs}ms)`);
      },
    });

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(
      join(outDir, "outcomes.jsonl"),
      `${outcomes.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    if (args.captureRaw && Object.keys(raws).length > 0) {
      writeFileSync(join(outDir, "raw.json"), `${JSON.stringify(raws, null, 2)}\n`);
    }

    console.log("");
    console.log(`[报告] ${join(outDir, "report.json")}`);
    console.log(
      `  通道 ${report.provider}（host=${report.baseUrlHost}）；请求模型 ${report.model}；` +
        `实际回答 ${report.responseModels.length > 0 ? report.responseModels.join(", ") : "未自报"}`,
    );
    console.log(
      `  样本 ${report.total}（成功 ${report.succeeded} / 失败 ${report.failed}）；` +
        `准确率 ${report.accuracy === null ? "无标签" : `${(report.accuracy * 100).toFixed(1)}%`}；` +
        `ECE ${report.ece === null ? "-" : report.ece.toFixed(3)}`,
    );
    console.log(
      `  自动化率 ${(report.autoRate * 100).toFixed(1)}%；人审(含转人工) ${(report.humanReviewRate * 100).toFixed(1)}%；` +
        `延迟 p50=${report.latency.p50}ms p95=${report.latency.p95}ms；成本 $${report.costUsd.toFixed(4)}`,
    );
    if (report.errors.length > 0) {
      console.log(`  失败 ${report.errors.length} 行：${report.errors.slice(0, 3).map((item) => item.id).join(", ")}${report.errors.length > 3 ? " …" : ""}`);
    }
    console.log("");
    console.log("下一步：把 report.json 与既有 L1 档模型的同集对照结果一起贴进任务卡回执；");
    console.log("        自动档只允许进影子账本；任何真实动作仍走围栏 + 人审（协议 §3）。");

    return report.failed === report.total ? 2 : 0;
  } finally {
    await mockServer?.close();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]).startsWith(resolve(HERE));
if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}
