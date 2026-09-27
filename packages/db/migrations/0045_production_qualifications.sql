-- 服务审核后的正式生成资格。签名只由持有独立签发密钥的服务生成；记录与脚本内容只增不改。
CREATE TABLE production_qualifications (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL UNIQUE NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES video_projects(id),
  shot_id TEXT NOT NULL,
  source_stage_run_id TEXT NOT NULL REFERENCES production_stage_runs(id),
  source_attempt INTEGER NOT NULL CHECK (source_attempt > 0),
  source_output_sha256 TEXT NOT NULL CHECK (source_output_sha256 ~ '^[a-f0-9]{64}$'),
  prompts_sha256 TEXT NOT NULL CHECK (prompts_sha256 ~ '^[a-f0-9]{64}$'),
  script_id TEXT REFERENCES render_scripts(id),
  script_version INTEGER CHECK (script_version > 0),
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  compiled_request JSONB NOT NULL,
  params JSONB NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('manual','batch','auto')),
  status TEXT NOT NULL CHECK (status IN ('passed','failed','unverified')),
  producer_verdict JSONB NOT NULL,
  issuer TEXT NOT NULL CHECK (issuer = 'workloom.production-authority'),
  key_id TEXT NOT NULL,
  signature TEXT,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  created_by TEXT NOT NULL,
  CHECK ((status = 'passed' AND script_id IS NOT NULL AND script_version IS NOT NULL AND signature IS NOT NULL)
      OR (status <> 'passed' AND script_id IS NULL AND script_version IS NULL AND signature IS NULL))
);
CREATE INDEX idx_pq_latest ON production_qualifications (tenant_id,workspace_id,project_id,shot_id,seq DESC);
CREATE INDEX idx_pq_script ON production_qualifications (workspace_id,script_id);
ALTER TABLE production_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_qualifications FORCE ROW LEVEL SECURITY;
CREATE POLICY production_qualifications_scope ON production_qualifications
 USING (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT, INSERT ON production_qualifications TO workloom_app,workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE production_qualifications_seq_seq TO workloom_app,workloom_gateway;

CREATE FUNCTION guard_production_qualification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'production qualification is append-only'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspaces w JOIN video_projects p ON p.workspace_id=w.id
      JOIN production_stage_runs r ON r.workspace_id=w.id AND r.project_id=p.id
    WHERE w.id=NEW.workspace_id AND w.tenant_id=NEW.tenant_id AND p.id=NEW.project_id
      AND r.id=NEW.source_stage_run_id AND r.stage_id='preproduction' AND r.status='done'
      AND r.attempt=NEW.source_attempt AND r.output_sha256=NEW.source_output_sha256
      AND NOT EXISTS (SELECT 1 FROM production_stage_runs newer WHERE newer.workspace_id=w.id
        AND newer.project_id=p.id AND newer.stage_id='preproduction' AND newer.attempt>r.attempt)
  ) THEN RAISE EXCEPTION 'production qualification source is not current'; END IF;
  IF NEW.status='passed' AND NOT EXISTS (
    SELECT 1 FROM render_scripts s WHERE s.id=NEW.script_id AND s.workspace_id=NEW.workspace_id
      AND s.project_id=NEW.project_id AND s.shot_id=NEW.shot_id AND s.version=NEW.script_version
  ) THEN RAISE EXCEPTION 'production qualification script scope mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_qualification_immutable BEFORE INSERT OR UPDATE OR DELETE ON production_qualifications
 FOR EACH ROW EXECUTE FUNCTION guard_production_qualification();

-- CMS 可变的是工作稿；已经签发的 canonical 脚本只允许状态投影变化。
-- 以迁移所有者读取资格，避免错误 tenant GUC 把双 scope RLS 下的资格行隐藏后绕过不可变检查。
CREATE FUNCTION guard_qualified_render_script() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.production_qualifications q WHERE q.script_id=OLD.id AND q.status='passed') THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'qualified render script is immutable'; END IF;
    IF ROW(NEW.id,NEW.workspace_id,NEW.project_id,NEW.shot_id,NEW.script_key,NEW.version,NEW.md,NEW.fields,NEW.created_by)
      IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.project_id,OLD.shot_id,OLD.script_key,OLD.version,OLD.md,OLD.fields,OLD.created_by)
    THEN RAISE EXCEPTION 'qualified render script is immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qualified_render_script_immutable BEFORE UPDATE OR DELETE ON render_scripts
 FOR EACH ROW EXECUTE FUNCTION guard_qualified_render_script();

REVOKE ALL ON FUNCTION guard_qualified_render_script() FROM PUBLIC;
