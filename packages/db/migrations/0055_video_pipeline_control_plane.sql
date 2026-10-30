-- ============================================================================
-- 0055_video_pipeline_control_plane.sql —— 视频管线持久化控制面
--   T-2026-1030-9001
--
-- 范围（WP2，不改变真实出片执行顺序）：
--   · PipelineRun：一次执行的冻结计划、源运行、项目 revision 与当前 frontier；
--   · 扩展 production_stage_runs：执行状态 / 验证状态 / disposition 三轴；
--   · ArtifactVersion、StageEdge、GateDecision、append-only PipelineEvent；
--   · 命令幂等回执。
--
-- 纪律：
--   · 旧执行器和旧 status 列保留，新增列均为兼容扩展；
--   · 文件/媒体字节仍在内容存储，本库只存引用与摘要；
--   · 所有业务表带 tenant_id + workspace_id 强制 RLS；
--   · 关键身份与合同字段不可原地换绑，状态只允许显式向前推进；
--   · 回滚可关闭新投影/仓储，旧执行器继续使用 production_stage_runs.status。
-- ============================================================================

-- ---------- 父运行 ----------

CREATE TABLE video_pipeline_runs (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  project_id            TEXT NOT NULL REFERENCES video_projects(id),
  plan_key              TEXT NOT NULL CHECK (length(plan_key) BETWEEN 1 AND 200),
  plan_version          INTEGER NOT NULL CHECK (plan_version > 0),
  plan_hash             TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  plan_json             JSONB NOT NULL CHECK (jsonb_typeof(plan_json) = 'object'),
  source_digest         TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  facts_snapshot_hash   TEXT NOT NULL CHECK (facts_snapshot_hash ~ '^[a-f0-9]{64}$'),
  status                TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','completed','partial','failed','interrupted')),
  revision              BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  current_frontier      JSONB NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(current_frontier) = 'array'),
  budget_grant_id       TEXT,
  source_system         TEXT NOT NULL CHECK (length(source_system) BETWEEN 1 AND 120),
  source_run_id         TEXT NOT NULL CHECK (length(source_run_id) BETWEEN 1 AND 300),
  created_by            TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, source_system, source_run_id),
  UNIQUE (tenant_id, workspace_id, project_id, plan_hash, source_system, source_run_id)
);

CREATE INDEX idx_vpr_project_updated
  ON video_pipeline_runs (tenant_id, workspace_id, project_id, updated_at DESC);
CREATE INDEX idx_vpr_frontier
  ON video_pipeline_runs (tenant_id, workspace_id, status, updated_at)
  WHERE status = 'running';

-- ---------- production_stage_runs：单表扩展，不另造平行 StageRun ----------

ALTER TABLE production_stage_runs
  ADD COLUMN tenant_id TEXT,
  ADD COLUMN pipeline_run_id TEXT,
  ADD COLUMN node_key TEXT,
  ADD COLUMN item_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN stage_contract_version INTEGER,
  ADD COLUMN plan_hash TEXT,
  ADD COLUMN facts_snapshot_hash TEXT,
  ADD COLUMN execution_status TEXT,
  ADD COLUMN verification_status TEXT,
  ADD COLUMN disposition TEXT,
  ADD COLUMN input_sha256 TEXT,
  ADD COLUMN contract_hash TEXT,
  ADD COLUMN repair_of_stage_run_id TEXT,
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN worker_token_hash TEXT,
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE production_stage_runs r
   SET tenant_id = w.tenant_id
  FROM workspaces w
 WHERE w.id = r.workspace_id AND r.tenant_id IS NULL;

ALTER TABLE production_stage_runs
  ADD CONSTRAINT production_stage_runs_pipeline_run_fk
    FOREIGN KEY (pipeline_run_id) REFERENCES video_pipeline_runs(id),
  ADD CONSTRAINT production_stage_runs_repair_fk
    FOREIGN KEY (repair_of_stage_run_id) REFERENCES production_stage_runs(id),
  ADD CONSTRAINT psr_control_status_check
    CHECK (execution_status IS NULL OR execution_status IN
      ('pending','ready','running','output_ready','completed','failed','interrupted')),
  ADD CONSTRAINT psr_verification_check
    CHECK (verification_status IS NULL OR verification_status IN
      ('not_run','pending','passed','rejected','unverified','not_applicable')),
  ADD CONSTRAINT psr_disposition_check
    CHECK (disposition IS NULL OR disposition IN
      ('continue','repair','reconcile','wait_human','blocked','done','stop')),
  ADD CONSTRAINT psr_contract_version_check
    CHECK (stage_contract_version IS NULL OR stage_contract_version > 0),
  ADD CONSTRAINT psr_revision_check CHECK (revision > 0),
  ADD CONSTRAINT psr_plan_hash_check
    CHECK (plan_hash IS NULL OR plan_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT psr_facts_hash_check
    CHECK (facts_snapshot_hash IS NULL OR facts_snapshot_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT psr_input_hash_check
    CHECK (input_sha256 IS NULL OR input_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT psr_contract_hash_check
    CHECK (contract_hash IS NULL OR contract_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT psr_worker_hash_check
    CHECK (worker_token_hash IS NULL OR worker_token_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT psr_control_fields_together CHECK (
    pipeline_run_id IS NULL
    OR (tenant_id IS NOT NULL AND node_key IS NOT NULL AND item_key IS NOT NULL
      AND stage_contract_version IS NOT NULL AND plan_hash IS NOT NULL
      AND facts_snapshot_hash IS NOT NULL AND execution_status IS NOT NULL
      AND verification_status IS NOT NULL AND disposition IS NOT NULL
      AND contract_hash IS NOT NULL AND idempotency_key IS NOT NULL)
  );

-- 旧执行器只认识 running/done/failed/skipped/interrupted；控制面需要完整三轴枚举。
ALTER TABLE production_stage_runs
  DROP CONSTRAINT IF EXISTS production_stage_runs_status_check;
ALTER TABLE production_stage_runs
  ADD CONSTRAINT production_stage_runs_status_check
  CHECK (status IN ('pending','ready','running','output_ready','completed','done','failed','skipped','interrupted'));

CREATE UNIQUE INDEX idx_psr_pipeline_node_attempt
  ON production_stage_runs (pipeline_run_id, node_key, item_key, attempt)
  WHERE pipeline_run_id IS NOT NULL;
CREATE UNIQUE INDEX idx_psr_workspace_idempotency
  ON production_stage_runs (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_psr_pipeline_frontier
  ON production_stage_runs (pipeline_run_id, execution_status, verification_status);
CREATE INDEX idx_psr_execution_status
  ON production_stage_runs (tenant_id, workspace_id, execution_status, updated_at)
  WHERE pipeline_run_id IS NOT NULL;

-- ---------- ArtifactVersion ----------

CREATE TABLE video_artifacts (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  pipeline_run_id       TEXT NOT NULL REFERENCES video_pipeline_runs(id),
  stage_run_id          TEXT NOT NULL REFERENCES production_stage_runs(id),
  role                  TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 120),
  schema_version        TEXT NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 200),
  content_type          TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 200),
  ref                   TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 2000),
  sha256                TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  logical_hash          TEXT NOT NULL CHECK (logical_hash ~ '^[a-f0-9]{64}$'),
  facts_snapshot_hash   TEXT NOT NULL CHECK (facts_snapshot_hash ~ '^[a-f0-9]{64}$'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stage_run_id, role, sha256)
);
CREATE INDEX idx_video_artifacts_run
  ON video_artifacts (pipeline_run_id, stage_run_id, created_at);

-- ---------- StageEdge ----------

CREATE TABLE video_stage_edges (
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  pipeline_run_id       TEXT NOT NULL REFERENCES video_pipeline_runs(id),
  parent_stage_run_id   TEXT NOT NULL REFERENCES production_stage_runs(id),
  child_stage_run_id    TEXT NOT NULL REFERENCES production_stage_runs(id),
  input_role            TEXT NOT NULL CHECK (length(input_role) BETWEEN 1 AND 120),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_run_id, parent_stage_run_id, child_stage_run_id, input_role),
  CHECK (parent_stage_run_id <> child_stage_run_id)
);
CREATE INDEX idx_video_stage_edges_child
  ON video_stage_edges (child_stage_run_id, parent_stage_run_id);

-- ---------- GateDecision ----------

CREATE TABLE video_gate_decisions (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  pipeline_run_id       TEXT NOT NULL REFERENCES video_pipeline_runs(id),
  stage_run_id          TEXT NOT NULL REFERENCES production_stage_runs(id),
  gate_key              TEXT NOT NULL CHECK (length(gate_key) BETWEEN 1 AND 120),
  check_set_version     TEXT NOT NULL CHECK (length(check_set_version) BETWEEN 1 AND 200),
  artifact_manifest_hash TEXT NOT NULL CHECK (artifact_manifest_hash ~ '^[a-f0-9]{64}$'),
  decision              TEXT NOT NULL CHECK (decision IN ('passed','rejected','unverified')),
  actor                 TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  artifact_hashes       JSONB NOT NULL CHECK (jsonb_typeof(artifact_hashes) = 'array'
                          AND jsonb_array_length(artifact_hashes) > 0),
  issues                JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(issues) = 'array'),
  suggestions           JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(suggestions) = 'array'),
  findings              JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  evidence_hashes       JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_hashes) = 'array'),
  approval_id           TEXT,
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_video_gate_decisions_stage
  ON video_gate_decisions (stage_run_id, created_at DESC);

-- ---------- append-only PipelineEvent ----------

CREATE TABLE video_pipeline_events (
  seq                   BIGSERIAL PRIMARY KEY,
  id                    TEXT NOT NULL UNIQUE,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  pipeline_run_id       TEXT REFERENCES video_pipeline_runs(id),
  stage_run_id          TEXT REFERENCES production_stage_runs(id),
  kind                  TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 160),
  idempotency_key       TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 500),
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, idempotency_key)
);
CREATE INDEX idx_video_pipeline_events_run
  ON video_pipeline_events (pipeline_run_id, seq);

-- ---------- 命令幂等回执 ----------

CREATE TABLE video_pipeline_command_receipts (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  idempotency_key       TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 500),
  request_hash          TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_json           JSONB NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, idempotency_key)
);

-- ============================================================================
-- 作用域校验
-- ============================================================================

CREATE FUNCTION guard_video_pipeline_run_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM video_projects p
      JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.id = NEW.project_id
       AND p.workspace_id = NEW.workspace_id
       AND w.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'video pipeline run project ownership mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER video_pipeline_runs_scope_guard
  BEFORE INSERT ON video_pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_run_scope();

CREATE FUNCTION guard_video_pipeline_child_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row video_pipeline_runs%ROWTYPE;
  stage_ref TEXT;
BEGIN
  SELECT * INTO run_row FROM video_pipeline_runs WHERE id = NEW.pipeline_run_id;
  IF run_row.id IS NULL
     OR run_row.tenant_id <> NEW.tenant_id
     OR run_row.workspace_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'video pipeline child run scope mismatch';
  END IF;
  stage_ref := to_jsonb(NEW)->>'stage_run_id';
  IF stage_ref IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM production_stage_runs s
     WHERE s.id = stage_ref
       AND s.pipeline_run_id = NEW.pipeline_run_id
       AND s.tenant_id = NEW.tenant_id
       AND s.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'video pipeline child stage scope mismatch';
  END IF;
  IF (to_jsonb(NEW) ? 'parent_stage_run_id') AND NOT EXISTS (
    SELECT 1
      FROM production_stage_runs p
      JOIN production_stage_runs c ON c.id = to_jsonb(NEW)->>'child_stage_run_id'
     WHERE p.id = to_jsonb(NEW)->>'parent_stage_run_id'
       AND p.pipeline_run_id = NEW.pipeline_run_id
       AND c.pipeline_run_id = NEW.pipeline_run_id
       AND p.tenant_id = NEW.tenant_id
       AND c.tenant_id = NEW.tenant_id
       AND p.workspace_id = NEW.workspace_id
       AND c.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'video pipeline edge stage scope mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_artifacts_scope_guard
  BEFORE INSERT ON video_artifacts
  FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_child_scope();
CREATE TRIGGER video_stage_edges_scope_guard
  BEFORE INSERT ON video_stage_edges
  FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_child_scope();
CREATE TRIGGER video_gate_decisions_scope_guard
  BEFORE INSERT ON video_gate_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_child_scope();

CREATE FUNCTION guard_video_pipeline_event_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pipeline_run_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM video_pipeline_runs
     WHERE id = NEW.pipeline_run_id
       AND tenant_id = NEW.tenant_id
       AND workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'video pipeline event run scope mismatch';
  END IF;
  IF NEW.stage_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM production_stage_runs
     WHERE id = NEW.stage_run_id
       AND pipeline_run_id = NEW.pipeline_run_id
       AND tenant_id = NEW.tenant_id
       AND workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'video pipeline event stage scope mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER video_pipeline_events_scope_guard
  BEFORE INSERT ON video_pipeline_events
  FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_event_scope();

CREATE FUNCTION guard_pipeline_stage_scope_and_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pipeline_run_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM video_pipeline_runs
       WHERE id = NEW.pipeline_run_id
         AND tenant_id = NEW.tenant_id
         AND workspace_id = NEW.workspace_id
         AND project_id = NEW.project_id
    ) THEN
      RAISE EXCEPTION 'pipeline stage run scope mismatch';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.project_id, NEW.pipeline_run_id,
         NEW.node_key, NEW.item_key, NEW.attempt, NEW.stage_contract_version, NEW.plan_hash,
         NEW.facts_snapshot_hash, NEW.contract_hash, NEW.idempotency_key, NEW.started_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.project_id, OLD.pipeline_run_id,
         OLD.node_key, OLD.item_key, OLD.attempt, OLD.stage_contract_version, OLD.plan_hash,
         OLD.facts_snapshot_hash, OLD.contract_hash, OLD.idempotency_key, OLD.started_at)
  THEN
    RAISE EXCEPTION 'pipeline stage identity is immutable';
  END IF;
  IF NEW.execution_status IS DISTINCT FROM OLD.execution_status AND NOT (
       OLD.execution_status IS NULL
    OR (OLD.execution_status = 'pending' AND NEW.execution_status IN ('ready','running','failed','interrupted'))
    OR (OLD.execution_status = 'ready' AND NEW.execution_status IN ('running','failed','interrupted'))
    OR (OLD.execution_status = 'running' AND NEW.execution_status IN ('output_ready','completed','failed','interrupted'))
    OR (OLD.execution_status = 'output_ready' AND NEW.execution_status IN ('completed','failed','interrupted'))
    OR (OLD.execution_status IN ('pending','ready') AND NEW.execution_status = 'completed'
        AND NEW.verification_status = 'not_applicable')
  ) THEN
    RAISE EXCEPTION 'pipeline stage execution transition forbidden';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status AND NOT (
       OLD.verification_status IS NULL
    OR OLD.verification_status = 'not_run'
    OR (OLD.verification_status = 'pending' AND NEW.verification_status IN ('passed','rejected','unverified','not_applicable'))
    OR (OLD.verification_status = 'passed' AND NEW.verification_status IN ('rejected','unverified','not_applicable'))
    OR (OLD.verification_status = 'rejected' AND NEW.verification_status IN ('passed','unverified','not_applicable'))
    OR (OLD.verification_status = 'unverified' AND NEW.verification_status IN ('passed','rejected','not_applicable'))
  ) THEN
    RAISE EXCEPTION 'pipeline stage verification transition forbidden';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pipeline_stage_scope_and_transition ON production_stage_runs;
CREATE TRIGGER pipeline_stage_scope_and_transition
  BEFORE INSERT OR UPDATE ON production_stage_runs
  FOR EACH ROW EXECUTE FUNCTION guard_pipeline_stage_scope_and_transition();

CREATE FUNCTION guard_pipeline_stage_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.pipeline_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'video pipeline stage evidence is append-only';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER pipeline_stage_no_control_delete
  BEFORE DELETE ON production_stage_runs
  FOR EACH ROW EXECUTE FUNCTION guard_pipeline_stage_delete();

-- 证据只增不改。
CREATE FUNCTION video_pipeline_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'video pipeline evidence is append-only';
END $$;
CREATE TRIGGER video_artifacts_immutable
  BEFORE UPDATE OR DELETE ON video_artifacts
  FOR EACH ROW EXECUTE FUNCTION video_pipeline_evidence_immutable();
CREATE TRIGGER video_stage_edges_immutable
  BEFORE UPDATE OR DELETE ON video_stage_edges
  FOR EACH ROW EXECUTE FUNCTION video_pipeline_evidence_immutable();
CREATE TRIGGER video_gate_decisions_immutable
  BEFORE UPDATE OR DELETE ON video_gate_decisions
  FOR EACH ROW EXECUTE FUNCTION video_pipeline_evidence_immutable();
CREATE TRIGGER video_pipeline_events_immutable
  BEFORE UPDATE OR DELETE ON video_pipeline_events
  FOR EACH ROW EXECUTE FUNCTION video_pipeline_evidence_immutable();
CREATE TRIGGER video_pipeline_command_receipts_immutable
  BEFORE UPDATE OR DELETE ON video_pipeline_command_receipts
  FOR EACH ROW EXECUTE FUNCTION video_pipeline_evidence_immutable();

-- ============================================================================
-- RLS / 权限
-- ============================================================================

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'video_pipeline_runs',
    'video_artifacts',
    'video_stage_edges',
    'video_gate_decisions',
    'video_pipeline_events',
    'video_pipeline_command_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = current_setting(''app.tenant_id'', true) AND workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true) AND workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_scope', t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON video_pipeline_runs TO workloom_app, workloom_gateway;
GRANT SELECT, INSERT, UPDATE ON production_stage_runs TO workloom_app, workloom_gateway;
GRANT SELECT, INSERT ON video_artifacts, video_stage_edges, video_gate_decisions,
  video_pipeline_events, video_pipeline_command_receipts TO workloom_app, workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE video_pipeline_events_seq_seq TO workloom_app, workloom_gateway;

-- 父 run 只允许 revision/status/frontier/updated_at 前进；冻结字段不可改。
CREATE FUNCTION guard_video_pipeline_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.project_id, NEW.plan_key, NEW.plan_version,
         NEW.plan_hash, NEW.plan_json, NEW.source_digest, NEW.facts_snapshot_hash,
         NEW.budget_grant_id, NEW.source_system, NEW.source_run_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.project_id, OLD.plan_key, OLD.plan_version,
         OLD.plan_hash, OLD.plan_json, OLD.source_digest, OLD.facts_snapshot_hash,
         OLD.budget_grant_id, OLD.source_system, OLD.source_run_id, OLD.created_by, OLD.created_at)
  THEN
    RAISE EXCEPTION 'video pipeline run identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'video pipeline run revision must advance by one';
  END IF;
  IF NOT (
       OLD.status = NEW.status
    OR (OLD.status = 'running' AND NEW.status IN ('completed','partial','failed','interrupted'))
  ) THEN
    RAISE EXCEPTION 'video pipeline run terminal status is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER video_pipeline_runs_update_guard
  BEFORE UPDATE ON video_pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_run_update();

CREATE FUNCTION guard_video_pipeline_stage_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pipeline_run_id IS NOT NULL AND TG_OP = 'UPDATE' THEN
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'pipeline stage revision must advance by one';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_stage_runs_revision_guard
  BEFORE UPDATE ON production_stage_runs
  FOR EACH ROW EXECUTE FUNCTION guard_video_pipeline_stage_revision();
