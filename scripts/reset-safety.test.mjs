import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

const sourceScript = new URL("./reset.sh", import.meta.url);
const fixtureRoots = [];
after(() => { for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true }); });

function databaseLocation(host = "127.0.0.1", database = "workloom") {
  return `postgres://demo@${host}:5432/${database}`;
}

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-reset-safety-"));
  fixtureRoots.push(root);
  const bin = join(root, "bin");
  const scripts = join(root, "scripts");
  mkdirSync(bin);
  mkdirSync(scripts);
  copyFileSync(sourceScript, join(scripts, "reset.sh"));
  const log = join(root, "calls.log");
  // Exercise the dangerous existing-config path using only a synthetic URL.
  writeFileSync(join(root, ".env"), `DATABASE_URL=${databaseLocation()}\n`, { mode: 0o600 });

  writeExecutable(join(bin, "psql"), `#!/usr/bin/env bash
set -euo pipefail
args="$*"
printf 'psql %s\\n' "$*" >>"$STUB_LOG"
if [ -n "\${PGHOSTADDR:-}" ] || [ -n "\${PGSERVICE:-}" ]; then exit 99; fi
if [ "\${STUB_QUERY_FAIL:-0}" = "1" ]; then exit 1; fi
case "$args" in
  *"DROP SCHEMA public CASCADE"*)
    if [ "\${STUB_RACE_CUSTOMER:-0}" = "1" ]; then exit 1; fi
    printf '%s\\n' drop >>"$STUB_LOG" ;;
  *"to_regclass('public.workspaces')"*) printf '%s\\n' "\${STUB_TABLE_STATE:-present}" ;;
  *"information_schema.columns"*) printf '%s\\n' "\${STUB_EXAMPLE_COLUMN:-1}" ;;
  *"is_example IS NOT TRUE"*) printf '%s\\n' "\${STUB_NON_EXAMPLE:-0}" ;;
  *) printf '%s\\n' unexpected-psql >>"$STUB_LOG" ;;
esac
`);
  writeExecutable(join(bin, "pg_dump"), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${STUB_BACKUP_FAIL:-0}" = "1" ]; then exit 1; fi
if [ "\${STUB_BACKUP_EMPTY:-0}" = "1" ]; then exit 0; fi
printf 'synthetic-backup-for-test\\n'
printf '%s\\n' backup >>"$STUB_LOG"
`);
  writeExecutable(join(bin, "pnpm"), `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >>"$STUB_LOG"
if [ "$*" = "db:migrate" ] && [ "\${STUB_MIGRATE_FAIL:-0}" = "1" ]; then exit 1; fi
`);

  writeExecutable(join(bin, "docker"), `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >>"$STUB_LOG"
if [ "\${STUB_DOCKER_PRESENT:-0}" != "1" ]; then exit 1; fi
case "$1" in info) exit 0 ;; ps) printf 'workloom-im-pg\\n' ;; *) exit 1 ;; esac
`);

  const env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    STUB_LOG: log,
    DATABASE_URL: databaseLocation(),
    NODE_ENV: "test",
  };
  const run = (args = [], overrides = {}) => spawnSync("bash", [join(scripts, "reset.sh"), ...args], {
    cwd: root,
    env: { ...env, ...overrides },
    encoding: "utf8",
    input: "",
  });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8") : "";
  return { root, run, calls };
}

test("非交互调用没有 --yes 时 fail closed，且不访问数据库", () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 64);
  assert.match(result.stderr, /非交互环境必须显式传入 --yes/);
  assert.equal(f.calls(), "");
});

test("远端、生产和数据库名不匹配目标始终拒绝", () => {
  for (const overrides of [
    { DATABASE_URL: databaseLocation("db.example.invalid") },
    { NODE_ENV: "production" },
    { NODE_ENV: "test", WORKLOOM_ENV: "production" },
    { DATABASE_URL: databaseLocation("127.0.0.1", "customer_prod") },
    { DATABASE_URL: "https://127.0.0.1:5432/workloom" },
    { DATABASE_URL: databaseLocation() + "?hostaddr=192.0.2.123" },
    { DATABASE_URL: databaseLocation() + "?%68ost=db.example.invalid" },
    { DATABASE_URL: databaseLocation() + "?dbname=customer_prod" },
    { DATABASE_URL: databaseLocation() + "?service=customer" },
  ]) {
    const f = fixture();
    const result = f.run(["--yes"], overrides);
    assert.notEqual(result.status, 0);
    assert.equal(f.calls(), "");
  }
  for (const declaration of ['NODE_ENV="production"', "WORKLOOM_ENV = 'prod' # deployment"]) {
    const f = fixture();
    writeFileSync(join(f.root, ".env"), `DATABASE_URL=${databaseLocation()}\n${declaration}\n`, { mode: 0o600 });
    const result = f.run(["--yes"]);
    assert.notEqual(result.status, 0);
    assert.equal(f.calls(), "");
  }
});

test("检测到非演示工作区时拒绝删除", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_NON_EXAMPLE: "2" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /非演示工作区/);
  assert.doesNotMatch(f.calls(), /drop|backup|pnpm/);
});

test("本机 workloom 纯演示库先备份，再事务重建并执行迁移种子", () => {
  const f = fixture();
  const result = f.run(["--yes"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(f.calls(), /backup/);
  assert.match(f.calls(), /drop/);
  assert.ok(f.calls().indexOf("backup") < f.calls().indexOf("drop"));
  assert.match(f.calls(), /-v ON_ERROR_STOP=1/);
  assert.match(f.calls(), /-X -w -v ON_ERROR_STOP=1/);
  assert.match(f.calls(), /BEGIN; LOCK TABLE public.workspaces IN ACCESS EXCLUSIVE MODE;/);
  assert.match(f.calls(), /IF EXISTS \(SELECT 1 FROM public.workspaces WHERE is_example IS NOT TRUE\)/);
  assert.match(f.calls(), /DROP SCHEMA public CASCADE; CREATE SCHEMA public; COMMIT;/);
  assert.match(f.calls(), /pnpm db:migrate/);
  assert.match(f.calls(), /pnpm db:seed/);
  assert.match(result.stdout, /已生成重置前备份/);
  const backups = join(f.root, "data/reset-backups");
  const files = readdirSync(backups);
  assert.equal(files.length, 1);
  assert.equal(statSync(join(backups, files[0])).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(backups, files[0]), "utf8"), "synthetic-backup-for-test\n");
});

test("未知参数 fail closed", () => {
  const f = fixture();
  const result = f.run(["--force"]);
  assert.equal(result.status, 64);
  assert.equal(f.calls(), "");
});


test("备份失败时禁止删除和后续迁移种子", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_BACKUP_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /重置前备份失败/);
  assert.doesNotMatch(f.calls(), /drop|pnpm/);
});

test("空备份不能证明可恢复，禁止删除", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_BACKUP_EMPTY: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /重置前备份为空/);
  assert.doesNotMatch(f.calls(), /drop|pnpm/);
});

test("客户类型查询失败或不可识别时禁止备份与删除", () => {
  for (const overrides of [{ STUB_QUERY_FAIL: "1" }, { STUB_TABLE_STATE: "unexpected" }, { STUB_TABLE_STATE: "absent" }, { STUB_EXAMPLE_COLUMN: "0" }]) {
    const f = fixture();
    const result = f.run(["--yes"], overrides);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(f.calls(), /drop|backup|pnpm/);
  }
});

test("明确的 IPv6 环回和 .env 后备目标可以重置，缺少配置拒绝", () => {
  const ipv6 = fixture();
  const v6 = ipv6.run(["--yes"], { DATABASE_URL: databaseLocation("[::1]") });
  assert.equal(v6.status, 0, v6.stderr);
  assert.match(ipv6.calls(), /drop/);
  const fallback = fixture();
  assert.equal(fallback.run(["-y"], { DATABASE_URL: "" }).status, 0);
  const quoted = fixture();
  writeFileSync(join(quoted.root, ".env"), `DATABASE_URL = "${databaseLocation()}" # local demo\n`, { mode: 0o600 });
  assert.equal(quoted.run(["--yes"], { DATABASE_URL: "" }).status, 0);
  assert.match(quoted.calls(), /drop/);
  const missing = fixture();
  rmSync(join(missing.root, ".env"));
  assert.notEqual(missing.run(["--yes"], { DATABASE_URL: "" }).status, 0);
  assert.equal(missing.calls(), "");
});

test("同名容器和连接路由环境变量不能替换已校验的目标", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_DOCKER_PRESENT: "1", PGHOSTADDR: "192.0.2.123", PGSERVICE: "customer" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(f.calls(), /docker/);
  assert.match(f.calls(), /psql postgres:\/\/demo@127\.0\.0\.1:5432\/workloom -X/);
});

test("删除事务发现并发客户工作区或 SQL 失败时禁止迁移和种子", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_RACE_CUSTOMER: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /重建事务失败或出现客户工作区/);
  assert.match(f.calls(), /backup/);
  assert.match(f.calls(), /LOCK TABLE public.workspaces IN ACCESS EXCLUSIVE MODE/);
  assert.doesNotMatch(f.calls(), /\ndrop\n|pnpm/);
});

test("迁移失败立即停止，备份保留且不继续种子", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_MIGRATE_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(f.calls(), /backup/);
  assert.match(f.calls(), /pnpm db:migrate/);
  assert.doesNotMatch(f.calls(), /pnpm db:seed/);
  assert.equal(readdirSync(join(f.root, "data/reset-backups")).length, 1);
});
