-- T-2026-0927-0025: 在供应商动作之前持久预占；render_jobs 保留原有状态合同。
-- reserved 可竞争一次 submitting；submitting/unknown 不按超时自动重发；
-- accepted 保留供应商 task_id，finalized 与 render_jobs/计量事件同一事务。
CREATE TABLE generation_submissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES video_projects(id),
  script_id TEXT NOT NULL REFERENCES render_scripts(id),
  script_version INTEGER NOT NULL CHECK (script_version >= 1),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  job_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','submitting','accepted','finalized','rejected','unknown')),
  owner_token TEXT,
  provider TEXT,
  provider_model TEXT,
  task_id TEXT,
  receipt JSONB,
  last_error TEXT,
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  CHECK (state NOT IN ('submitting','accepted','finalized','unknown') OR owner_token IS NOT NULL),
  CHECK (state NOT IN ('accepted','finalized') OR
    (task_id IS NOT NULL AND length(task_id) > 0 AND provider IS NOT NULL AND receipt IS NOT NULL))
);

CREATE INDEX idx_generation_submissions_reconcile
  ON generation_submissions (workspace_id, state, updated_at)
  WHERE state IN ('submitting','accepted','unknown');

GRANT SELECT, INSERT, UPDATE ON generation_submissions TO workloom_app, workloom_gateway;
ALTER TABLE generation_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY generation_submissions_scope ON generation_submissions
  USING (workspace_id = current_setting('app.workspace_id', true)
    AND tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)
    AND tenant_id = current_setting('app.tenant_id', true));

-- 身份不可换绑，终态回执不可覆盖。租户/项目/脚本版本关系在落行时验证。
CREATE FUNCTION guard_generation_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM render_scripts s
      JOIN video_projects p ON p.id=s.project_id AND p.workspace_id=s.workspace_id
      JOIN workspaces w ON w.id=s.workspace_id
      WHERE s.id=NEW.script_id AND s.version=NEW.script_version AND s.project_id=NEW.project_id
        AND s.workspace_id=NEW.workspace_id AND w.tenant_id=NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'generation submission scope mismatch';
    END IF;
    IF NEW.state <> 'reserved' OR NEW.owner_token IS NOT NULL OR NEW.dispatch_count <> 0 THEN
      RAISE EXCEPTION 'generation submission must begin reserved';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.project_id, NEW.script_id, NEW.script_version,
           NEW.idempotency_key, NEW.request_hash, NEW.job_id, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.project_id, OLD.script_id, OLD.script_version,
           OLD.idempotency_key, OLD.request_hash, OLD.job_id, OLD.created_at) THEN
      RAISE EXCEPTION 'generation submission identity is immutable';
    END IF;
    IF OLD.owner_token IS NOT NULL AND NEW.owner_token IS DISTINCT FROM OLD.owner_token THEN
      RAISE EXCEPTION 'generation submission owner is immutable';
    END IF;
    IF NOT ((OLD.state='reserved' AND NEW.state='submitting')
      OR (OLD.state='submitting' AND NEW.state IN ('submitting','accepted','rejected','unknown'))
      OR (OLD.state='accepted' AND NEW.state='finalized')) THEN
      RAISE EXCEPTION 'generation submission transition forbidden';
    END IF;
    IF OLD.state='accepted' AND ROW(NEW.provider, NEW.provider_model, NEW.task_id, NEW.receipt, NEW.dispatch_count)
       IS DISTINCT FROM ROW(OLD.provider, OLD.provider_model, OLD.task_id, OLD.receipt, OLD.dispatch_count) THEN
      RAISE EXCEPTION 'generation accepted receipt is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER generation_submission_guard BEFORE INSERT OR UPDATE ON generation_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_generation_submission();
