-- ============================================================================
-- 0046_registered_film_workers.sql —— 全链影片固定工位与组件调用台账
--   （T-2026-0927-0039 / Issue 277）
--
-- 目的：公开 full-chain 入口不再由本机密钥直连供应商。服务把「原稿」冻结进项目档案，
-- 按登记摘要启动固定工位子进程（子进程不持供应商/签发密钥），工位的每一次外呼都经
-- 作用域受限的父服务通道，并**先留账后外呼**（费用与幂等预占）。
--
-- 三张表：
--   ① film_workers            固定工位登记（代码路径 + 摘要 + 能力清单；改代码必须重登记）
--   ② film_jobs               作业（服务冻结输入 → 启动工位 → 终态回执，attempt 递增）
--   ③ film_component_requests 组件调用台账（reserved → dispatched → accepted/failed/unknown）
--
-- 纪律与既有台账同构（0044/0045）：
--   · 只增不改：身份字段不可换绑；终态回执不可覆盖；进行中状态只允许一次认领。
--   · RLS：所有行按租户/工作区强制隔离；业务与网关角色都受策略约束。
--   · 拒绝盲重发：dispatched/unknown 不按超时自动重发，须对账。
--
-- 依赖：0001_init.sql（tenants/workspaces）、0009_video_studio.sql（video_projects）、
--      0038_production_archive.sql（production_stage_runs 口径）、0044/0045（台账范式）。
-- 回滚：删除本文件三张表与函数即可；不修改任何既有表语义。
-- ============================================================================

-- ---------- ① 固定工位登记 ----------
CREATE TABLE film_workers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  worker_name TEXT NOT NULL CHECK (length(worker_name) BETWEEN 1 AND 120),
  worker_version TEXT NOT NULL CHECK (length(worker_version) BETWEEN 1 AND 120),
  /** 仓库内相对路径；服务解析时再做越界/符号链接检查（SQL 层拒绝绝对路径与 .. 片段）。 */
  entry_path TEXT NOT NULL CHECK (left(entry_path, 1) <> '/' AND entry_path !~ '(^|/)\.\.(/|$)'),
  entry_sha256 TEXT NOT NULL CHECK (entry_sha256 ~ '^[a-f0-9]{64}$'),
  /** 允许的通道方法清单（JSON 数组，服务端仍以代码白名单为准，此处留审计证据）。 */
  capabilities JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  registered_by TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  /** 同一工位名可保留多份历史登记（代码摘要不同），但同一时刻只允许一份 active（见下方部分唯一索引）。 */
  UNIQUE (tenant_id, workspace_id, worker_name, entry_sha256),
  CHECK (jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) > 0)
);
CREATE INDEX idx_film_workers_lookup ON film_workers (tenant_id, workspace_id, worker_name, status);
CREATE UNIQUE INDEX idx_film_workers_single_active ON film_workers (tenant_id, workspace_id, worker_name)
  WHERE status = 'active';

ALTER TABLE film_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE film_workers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS film_workers_scope ON film_workers;
CREATE POLICY film_workers_scope ON film_workers
 USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT, INSERT, UPDATE ON film_workers TO workloom_app,workloom_gateway;

-- 登记身份不可换绑；代码摘要只能在停用后由新登记行取代，禁止原地改写摘要。
CREATE FUNCTION guard_film_worker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'film worker must be registered active'; END IF;
    IF NEW.registered_at IS DISTINCT FROM NEW.updated_at AND NEW.updated_at < NEW.registered_at THEN
      RAISE EXCEPTION 'film worker timestamps invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.worker_name, NEW.registered_by, NEW.registered_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.worker_name, OLD.registered_by, OLD.registered_at) THEN
    RAISE EXCEPTION 'film worker identity is immutable';
  END IF;
  IF NEW.entry_path IS DISTINCT FROM OLD.entry_path OR NEW.entry_sha256 IS DISTINCT FROM OLD.entry_sha256 THEN
    RAISE EXCEPTION 'film worker code digest is immutable; register a new revision instead';
  END IF;
  IF NOT ((OLD.status = 'active' AND NEW.status IN ('active','disabled'))
    OR (OLD.status = 'disabled' AND NEW.status = 'active')
    OR (OLD.status = 'disabled' AND NEW.status = 'disabled')) THEN
    RAISE EXCEPTION 'film worker status transition forbidden';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS film_workers_guard ON film_workers;
CREATE TRIGGER film_workers_guard BEFORE INSERT OR UPDATE ON film_workers
  FOR EACH ROW EXECUTE FUNCTION guard_film_worker();

-- ---------- ② 工位作业 ----------
CREATE TABLE film_jobs (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL UNIQUE NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES video_projects(id),
  worker_id TEXT NOT NULL REFERENCES film_workers(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('running','finished','failed','interrupted')),
  /** 本次执行的阶段清单（服务冻结，工位不得增删）。 */
  stages JSONB NOT NULL,
  /** 冻结选项（--only/画幅/清晰度/平台等；只读审计）。 */
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  /** 作业总预算（人民币；服务冻结，组件预占累计不得超过它）。 */
  budget_cny NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (budget_cny >= 0),
  /** 服务冻结的原稿：项目档案内相对引用 + 摘要。 */
  input_ref TEXT NOT NULL CHECK (left(input_ref, 1) <> '/' AND input_ref !~ '(^|/)\.\.(/|$)'),
  input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  /** 启动时实际校验的工位代码摘要（与 film_workers.entry_sha256 一致）。 */
  worker_entry_sha256 TEXT NOT NULL CHECK (worker_entry_sha256 ~ '^[a-f0-9]{64}$'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error_class TEXT,
  error_msg TEXT,
  result_ref TEXT,
  result_sha256 TEXT CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[a-f0-9]{64}$'),
  created_by TEXT NOT NULL,
  UNIQUE (tenant_id, workspace_id, project_id, attempt),
  CHECK (status = 'running' OR finished_at IS NOT NULL),
  CHECK (status <> 'finished' OR (result_ref IS NOT NULL AND result_sha256 IS NOT NULL))
);
CREATE INDEX idx_film_jobs_active ON film_jobs (workspace_id, project_id, status, seq DESC);
CREATE INDEX idx_film_jobs_reconcile ON film_jobs (workspace_id, status, started_at)
  WHERE status = 'running';

ALTER TABLE film_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE film_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS film_jobs_scope ON film_jobs;
CREATE POLICY film_jobs_scope ON film_jobs
 USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT, INSERT, UPDATE ON film_jobs TO workloom_app,workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE film_jobs_seq_seq TO workloom_app,workloom_gateway;

CREATE FUNCTION guard_film_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' OR NEW.finished_at IS NOT NULL OR NEW.result_ref IS NOT NULL OR NEW.result_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'film job must begin running without a terminal receipt';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM film_workers w JOIN video_projects p ON p.workspace_id = w.workspace_id
        JOIN workspaces ws ON ws.id = w.workspace_id
      WHERE w.id = NEW.worker_id AND w.tenant_id = NEW.tenant_id AND w.workspace_id = NEW.workspace_id
        AND w.status = 'active' AND p.id = NEW.project_id AND ws.tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'film job scope or worker registration mismatch';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.project_id, NEW.worker_id, NEW.attempt, NEW.run_id,
         NEW.stages, NEW.options, NEW.budget_cny, NEW.input_ref, NEW.input_sha256, NEW.worker_entry_sha256, NEW.started_at, NEW.created_by)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.project_id, OLD.worker_id, OLD.attempt, OLD.run_id,
         OLD.stages, OLD.options, OLD.budget_cny, OLD.input_ref, OLD.input_sha256, OLD.worker_entry_sha256, OLD.started_at, OLD.created_by) THEN
    RAISE EXCEPTION 'film job identity is immutable';
  END IF;
  IF OLD.status <> 'running' THEN
    IF ROW(NEW.status, NEW.finished_at, NEW.error_class, NEW.error_msg, NEW.result_ref, NEW.result_sha256)
       IS DISTINCT FROM ROW(OLD.status, OLD.finished_at, OLD.error_class, OLD.error_msg, OLD.result_ref, OLD.result_sha256) THEN
      RAISE EXCEPTION 'film job terminal receipt is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'running' THEN
    IF NEW.finished_at IS NOT NULL OR NEW.result_ref IS NOT NULL OR NEW.result_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'running film job must not carry a terminal receipt';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'finished' THEN
    IF NEW.result_ref IS NULL OR NEW.result_sha256 IS NULL OR NEW.error_msg IS NOT NULL THEN
      RAISE EXCEPTION 'finished film job requires result receipt without error';
    END IF;
  ELSIF NEW.error_msg IS NULL THEN
    RAISE EXCEPTION 'failed/interrupted film job requires an error message';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS film_jobs_guard ON film_jobs;
CREATE TRIGGER film_jobs_guard BEFORE INSERT OR UPDATE ON film_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_film_job();

-- ---------- ③ 组件调用台账（先留账后外呼） ----------
CREATE TABLE film_component_requests (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL CHECK (seq > 0),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES video_projects(id),
  job_id TEXT NOT NULL REFERENCES film_jobs(id),
  component TEXT NOT NULL CHECK (component IN ('llm','image','video','media','voice','review')),
  /** 工位声明的当前步骤键（阶段/镜头），服务据此核对作业冻结的阶段范围。 */
  step_key TEXT NOT NULL CHECK (length(step_key) BETWEEN 1 AND 200),
  shot_id TEXT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 400),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','dispatched','accepted','failed','unknown')),
  owner_token TEXT,
  provider TEXT,
  provider_model TEXT,
  reserved_cny NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (reserved_cny >= 0),
  actual_cny NUMERIC(12,4) CHECK (actual_cny IS NULL OR actual_cny >= 0),
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq),
  UNIQUE (job_id, idempotency_key),
  CHECK (state = 'reserved' OR owner_token IS NOT NULL),
  CHECK (state <> 'accepted' OR (provider IS NOT NULL AND length(provider) > 0 AND evidence ? 'artifactSha256')),
  CHECK (state <> 'failed' OR evidence ? 'failureClass')
);
CREATE INDEX idx_film_component_job ON film_component_requests (job_id, seq);
CREATE INDEX idx_film_component_reconcile ON film_component_requests (workspace_id, state, updated_at)
  WHERE state IN ('dispatched','unknown');

ALTER TABLE film_component_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE film_component_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS film_component_requests_scope ON film_component_requests;
CREATE POLICY film_component_requests_scope ON film_component_requests
 USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT, INSERT, UPDATE ON film_component_requests TO workloom_app,workloom_gateway;

CREATE FUNCTION guard_film_component_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' OR NEW.owner_token IS NOT NULL THEN
      RAISE EXCEPTION 'film component request must begin reserved without an owner';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM film_jobs j WHERE j.id = NEW.job_id AND j.tenant_id = NEW.tenant_id
        AND j.workspace_id = NEW.workspace_id AND j.project_id = NEW.project_id AND j.status = 'running'
    ) THEN
      RAISE EXCEPTION 'film component request requires a running job in scope';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.project_id, NEW.job_id, NEW.component, NEW.step_key,
         NEW.shot_id, NEW.idempotency_key, NEW.request_hash, NEW.payload_hash, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.project_id, OLD.job_id, OLD.component, OLD.step_key,
         OLD.shot_id, OLD.idempotency_key, OLD.request_hash, OLD.payload_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'film component request identity is immutable';
  END IF;
  IF OLD.owner_token IS NOT NULL AND NEW.owner_token IS DISTINCT FROM OLD.owner_token THEN
    RAISE EXCEPTION 'film component request owner is immutable';
  END IF;
  IF NOT ((OLD.state = 'reserved' AND NEW.state IN ('dispatched','failed'))
    OR (OLD.state = 'dispatched' AND NEW.state IN ('dispatched','accepted','failed','unknown'))
    OR (OLD.state IN ('accepted','failed','unknown') AND NEW.state = OLD.state)) THEN
    RAISE EXCEPTION 'film component request transition forbidden';
  END IF;
  IF OLD.state IN ('accepted','failed') AND
     ROW(NEW.state, NEW.provider, NEW.provider_model, NEW.reserved_cny, NEW.actual_cny,
         NEW.evidence - 'reconciledAt', NEW.dispatch_count)
     IS DISTINCT FROM
     ROW(OLD.state, OLD.provider, OLD.provider_model, OLD.reserved_cny, OLD.actual_cny,
         OLD.evidence - 'reconciledAt', OLD.dispatch_count) THEN
    RAISE EXCEPTION 'film component terminal receipt is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS film_component_requests_guard ON film_component_requests;
CREATE TRIGGER film_component_requests_guard BEFORE INSERT OR UPDATE ON film_component_requests
  FOR EACH ROW EXECUTE FUNCTION guard_film_component_request();
