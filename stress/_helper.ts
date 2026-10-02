/**
 * stress/_helper.ts —— 排雷压测公共工具
 * 前置：server 运行中（pnpm -C apps/server dev）、.env 已配置、迁移+种子完成。
 * 适用基线：审计基线 e71f30c（及之后修复基线，脚本用于红→绿回归）。
 */
import pg from "pg";

export const PORT = Number(process.env.SERVER_PORT ?? 8787);
export const BASE = `http://localhost:${PORT}`;
export const WS_SLUG = process.env.STRESS_WS ?? "yunqi-hotel";
export const MEMBER_NO = process.env.STRESS_MEMBER ?? "MEM-001";
export const RUN_ID = `S${Date.now().toString(36)}`; // 每次运行唯一后缀，保证可复跑不撞号

export class TrpcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TrpcError";
  }
}

export async function trpc<T = unknown>(
  path: string,
  opts: { input?: unknown; token?: string; method?: "query" | "mutation" } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let res: Response;
  if (opts.method === "mutation") {
    res = await fetch(`${BASE}/trpc/${path}`, { method: "POST", headers, body: JSON.stringify(opts.input ?? {}) });
  } else {
    const qs = opts.input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(opts.input))}`;
    res = await fetch(`${BASE}/trpc/${path}${qs}`, { headers });
  }
  const body = (await res.json()) as { result?: { data?: unknown }; error?: { message?: string; data?: { code?: string } } };
  if (body.error) throw new TrpcError(body.error.data?.code ?? "ERROR", body.error.message ?? "未知 tRPC 错误");
  return body.result?.data as T;
}

/** 数据库特权直查（owner 池，仅取证/造测试现场用） */
export function ownerPool(): pg.Pool {
  return new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom" });
}
export function gatewayPool(): pg.Pool {
  return new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL ?? "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom" });
}

export async function login(slug = WS_SLUG, memberNo = MEMBER_NO): Promise<string> {
  const r = await trpc<{ token: string }>("auth.loginAs", { method: "mutation", input: { workspaceSlug: slug, memberNo } });
  return r.token;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

export function scene(t: string): void { console.log(`\n══ ${t} ══`); }
export function step(t: string): void { console.log(`  → ${t}`); }
export function ok(name: string, detail?: string): void {
  passed += 1;
  console.log(`  ✅ PASS ${name}${detail ? ` —— ${detail}` : ""}`);
}
export function bad(name: string, detail?: string): void {
  failed += 1;
  failures.push(name);
  console.error(`  ❌ FAIL ${name}${detail ? ` —— ${detail}` : ""}`);
}
/** cond=true 表示系统行为正确（断言绿） */
export function check(name: string, cond: boolean, detail?: string): void {
  if (cond) ok(name, detail); else bad(name, detail);
}
export function summary(): void {
  console.log(`\n══ 汇总：${passed} 通过 / ${failed} 失败 ══`);
  if (failures.length) console.error(`未闭环：${failures.join("；")}`);
  process.exit(failed ? 1 : 0);
}
