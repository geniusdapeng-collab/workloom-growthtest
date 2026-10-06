#!/usr/bin/env bash
# WorkLoom IM 底座 · 数据重置（演示剧本前置：回到干净的云栖酒店数据集）
# 注意：biz_events 为 append-only（触发器禁 DELETE，L1.1），
#      因此重置 = 整库重建（drop schema）→ 迁移 → 种子，而非清表。
# 用法：./scripts/reset.sh [--yes]（--yes/-y 仅跳过交互确认；目标安全校验与备份永不跳过）
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

fail() { printf "❌ %s\n" "$1" >&2; exit "${2:-1}"; }

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    *) fail "未知参数：${arg}（仅支持 --yes/-y）" 64 ;;
  esac
done

echo "== WorkLoom IM 底座 · 重置演示数据 =="
echo "⚠️  将删除本地演示库全部数据（append-only 事件库只能整库重建）"

command -v node >/dev/null 2>&1 || fail "Node 不可用，无法安全解析重置配置"
# 不执行 .env；同时检查文件与继承环境，显式 DATABASE_URL 也不能掩盖生产声明。
DB_URL=$(node -e '
try {
  const fs = require("node:fs");
  const declarations = fs.existsSync(".env")
    ? require("node:util").parseEnv(fs.readFileSync(".env", "utf8")) : {};
  const environments = [process.env.NODE_ENV, process.env.WORKLOOM_ENV,
    declarations.NODE_ENV, declarations.WORKLOOM_ENV];
  if (environments.some(value => ["production", "prod"].includes(String(value ?? "").trim().toLowerCase()))) {
    process.stderr.write("生产环境禁止运行演示数据重置\n");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL || declarations.DATABASE_URL;
  if (!url) {
    process.stderr.write("未显式提供 DATABASE_URL 且 .env 没有有效目标，拒绝猜测重置目标\n");
    process.exit(1);
  }
  process.stdout.write(url);
} catch {
  process.stderr.write(".env 无法安全读取或解析，拒绝重置\n");
  process.exit(1);
}
') || fail "环境与连接配置安全校验未通过，未访问数据库"
[ -n "$DB_URL" ] || fail "DATABASE_URL 为空，拒绝重置"

TARGET=$(DATABASE_URL="$DB_URL" node -e '
try {
  const u = new URL(process.env.DATABASE_URL);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const database = decodeURIComponent(u.pathname.slice(1));
  const routing = ["host", "hostaddr", "port", "dbname", "service", "servicefile", "options"];
  if (!["postgres:", "postgresql:"].includes(u.protocol) || u.hash ||
      routing.some(key => u.searchParams.has(key)) ||
      !["localhost", "127.0.0.1", "::1"].includes(host) || database !== "workloom") process.exit(1);
  process.stdout.write([host, u.port || "5432", database].join("|"));
} catch { process.exit(1); }
') || fail "只允许明确指向本机 workloom 演示库的 PostgreSQL URL；连接重定向参数禁止用于重置"
IFS='|' read -r DB_HOST DB_PORT DB_NAME <<< "$TARGET"

case "$DB_HOST" in
  localhost|127.0.0.1|::1) ;;
  *) fail "只允许重置本机演示库；当前目标主机为 ${DB_HOST:-<empty>}" ;;
esac
[ "$DB_NAME" = "workloom" ] || fail "只允许重置名为 workloom 的演示库；当前数据库为 ${DB_NAME:-<empty>}"

if [ "$ASSUME_YES" != "1" ]; then
  [ -t 0 ] || fail "非交互环境必须显式传入 --yes；本次未执行任何删除" 64
  read -r -p "确认重置 ${DB_HOST}:${DB_PORT}/${DB_NAME}？请输入数据库名 workloom：" answer
  [ "$answer" = "workloom" ] || { echo "已取消，未修改数据库"; exit 0; }
fi

# 始终连接校验过的 URL，不因同名 Docker 容器或 PG 路由变量而切换目标。
command -v psql >/dev/null 2>&1 || fail "psql 不可用，拒绝在无法核验目标的情况下重置"
command -v pg_dump >/dev/null 2>&1 || fail "pg_dump 不可用，无法生成重置前备份"
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS
export PGCONNECT_TIMEOUT=10 DATABASE_URL="$DB_URL"
db_query() { psql "$DB_URL" -X -w -v ON_ERROR_STOP=1 -Atq -c "$1"; }
db_backup() { pg_dump "$DB_URL" -w -Fc; }

TABLE_STATE=$(db_query "SELECT CASE WHEN to_regclass('public.workspaces') IS NULL THEN 'absent' ELSE 'present' END" \
  || fail "无法核验目标数据库，拒绝重置")
if [ "$TABLE_STATE" = "present" ]; then
  HAS_EXAMPLE_COLUMN=$(db_query "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='workspaces' AND column_name='is_example'" \
    || fail "无法核验工作区类型，拒绝重置")
  [ "$HAS_EXAMPLE_COLUMN" = "1" ] || fail "workspaces.is_example 缺失，无法证明这是演示库，拒绝重置"
  NON_EXAMPLE=$(db_query "SELECT count(*) FROM workspaces WHERE is_example IS NOT TRUE" \
    || fail "无法核验客户工作区，拒绝重置")
  [ "$NON_EXAMPLE" = "0" ] || fail "检测到 $NON_EXAMPLE 个非演示工作区；禁止用演示重置脚本删除客户数据"
else
  fail "无法识别已迁移的演示数据库结构，拒绝重置"
fi

BACKUP_DIR="data/reset-backups"
BACKUP_PATH="$BACKUP_DIR/${DB_NAME}-$(date -u '+%Y%m%dT%H%M%SZ')-$$.dump"
mkdir -p "$BACKUP_DIR"
db_backup >"$BACKUP_PATH" || fail "重置前备份失败，未执行删除"
[ -s "$BACKUP_PATH" ] || fail "重置前备份为空，未执行删除"
echo "✅ 已生成重置前备份：$BACKUP_PATH"

db_query "BEGIN; LOCK TABLE public.workspaces IN ACCESS EXCLUSIVE MODE;
DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM public.workspaces WHERE is_example IS NOT TRUE)
THEN RAISE EXCEPTION 'Customer workspace appeared before reset'; END IF; END \$\$;
DROP SCHEMA public CASCADE; CREATE SCHEMA public; COMMIT;" >/dev/null \
  || fail "重建事务失败或出现客户工作区，未执行迁移与种子；备份已保留"
echo "✅ schema 已重建"

pnpm db:migrate
pnpm db:seed
echo "== 重置完成：云栖酒店演示数据集（含「昨夜」夜班数据）已就绪 =="
