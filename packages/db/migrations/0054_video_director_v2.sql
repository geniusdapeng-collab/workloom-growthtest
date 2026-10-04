-- Industry-local director delegation, immutable plans, job receipts and explicit preferences.
CREATE TABLE video_creative_delegations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES video_projects(id),
  run_id TEXT NOT NULL,
  grant_event_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, project_id, run_id),
  FOREIGN KEY (tenant_id, grant_event_id) REFERENCES biz_events(tenant_id,event_id),
  CHECK (payload->>'policyHash'=policy_hash AND payload->>'projectId'=project_id AND payload->>'runId'=run_id
    AND payload->>'tenantId'=tenant_id AND payload->>'workspaceId'=workspace_id AND payload->>'grantEventId'=grant_event_id)
);
CREATE TABLE video_director_plans (
  tenant_id TEXT NOT NULL REFERENCES tenants(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES video_projects(id), revision INTEGER NOT NULL CHECK (revision > 0),
  plan_hash TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  target_plan JSONB NOT NULL, source_manifest JSONB NOT NULL, variant_plans JSONB NOT NULL,
  film_plan JSONB NOT NULL DEFAULT '{}',
  source_refs JSONB NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,workspace_id,project_id,revision), UNIQUE (tenant_id,workspace_id,project_id,plan_hash)
);
CREATE TABLE video_director_jobs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES video_projects(id), revision INTEGER NOT NULL CHECK (revision > 0),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('queued','running','complete','partial','failed','interrupted','requires-generation-plan')),
  payload JSONB NOT NULL, receipt JSONB, error_code TEXT, created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,idempotency_key),
  CHECK (status NOT IN ('complete','partial','requires-generation-plan') OR receipt IS NOT NULL)
);
CREATE UNIQUE INDEX video_director_one_active ON video_director_jobs(tenant_id,workspace_id,project_id)
  WHERE status IN ('queued','running');
CREATE INDEX video_director_jobs_project ON video_director_jobs(tenant_id,workspace_id,project_id,created_at DESC);
CREATE TABLE video_director_preferences (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  subject_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES video_projects(id), source_event_id TEXT NOT NULL,
  feedback TEXT NOT NULL CHECK (length(feedback) BETWEEN 1 AND 10000),
  origin TEXT NOT NULL CHECK (origin='explicit'), attribution JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,source_event_id) REFERENCES biz_events(tenant_id,event_id)
);
CREATE INDEX video_director_preferences_subject ON video_director_preferences(tenant_id,workspace_id,subject_id,created_at DESC);

CREATE TABLE video_director_audio_sources (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES video_projects(id), revision INTEGER NOT NULL CHECK (revision>0),
  shot_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('dialogue','ambience','foley','music')),
  binding_sha256 TEXT NOT NULL CHECK (binding_sha256 ~ '^[a-f0-9]{64}$'),
  source_event_id TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,source_event_id) REFERENCES biz_events(tenant_id,event_id),
  UNIQUE(tenant_id,workspace_id,project_id,revision,shot_id,role,binding_sha256)
);
CREATE TABLE video_director_choices (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES video_projects(id), revision INTEGER NOT NULL CHECK(revision>0),
  variant_id TEXT NOT NULL, recipe_version TEXT NOT NULL, plan_hash TEXT NOT NULL,
  score INTEGER CHECK(score BETWEEN 1 AND 5), blind_label TEXT, feedback TEXT,
  source_event_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,source_event_id) REFERENCES biz_events(tenant_id,event_id)
);
CREATE INDEX video_director_choices_recipe ON video_director_choices(tenant_id,workspace_id,recipe_version,variant_id,created_at DESC);

CREATE FUNCTION video_director_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'director evidence is append-only; create a new revision'; END $$;
CREATE TRIGGER video_creative_delegations_immutable BEFORE UPDATE OR DELETE ON video_creative_delegations FOR EACH ROW EXECUTE FUNCTION video_director_immutable();
CREATE TRIGGER video_director_plans_immutable BEFORE UPDATE OR DELETE ON video_director_plans FOR EACH ROW EXECUTE FUNCTION video_director_immutable();
CREATE TRIGGER video_director_preferences_immutable BEFORE UPDATE OR DELETE ON video_director_preferences FOR EACH ROW EXECUTE FUNCTION video_director_immutable();
CREATE TRIGGER video_director_audio_sources_immutable BEFORE UPDATE OR DELETE ON video_director_audio_sources FOR EACH ROW EXECUTE FUNCTION video_director_immutable();
CREATE TRIGGER video_director_choices_immutable BEFORE UPDATE OR DELETE ON video_director_choices FOR EACH ROW EXECUTE FUNCTION video_director_immutable();

CREATE FUNCTION video_director_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.workspace_id,NEW.project_id,NEW.revision,NEW.idempotency_key,NEW.request_hash,NEW.payload,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.workspace_id,OLD.project_id,OLD.revision,OLD.idempotency_key,OLD.request_hash,OLD.payload,OLD.created_by,OLD.created_at)
    THEN RAISE EXCEPTION 'director job identity is immutable'; END IF;
  IF OLD.status NOT IN ('queued','running') AND ROW(NEW.status,NEW.receipt,NEW.error_code) IS DISTINCT FROM ROW(OLD.status,OLD.receipt,OLD.error_code)
    THEN RAISE EXCEPTION 'director job terminal receipt is immutable'; END IF;
  IF NOT ((OLD.status='queued' AND NEW.status IN ('running','failed','interrupted'))
    OR (OLD.status='running' AND NEW.status IN ('complete','partial','failed','interrupted','requires-generation-plan')) OR OLD.status=NEW.status)
    THEN RAISE EXCEPTION 'director job transition forbidden'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER video_director_jobs_guard BEFORE UPDATE ON video_director_jobs FOR EACH ROW EXECUTE FUNCTION video_director_job_guard();
CREATE TRIGGER video_director_jobs_no_delete BEFORE DELETE ON video_director_jobs FOR EACH ROW EXECUTE FUNCTION video_director_immutable();

CREATE FUNCTION video_director_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_ref TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM video_projects p JOIN workspaces w ON w.id=p.workspace_id
    WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND w.tenant_id=NEW.tenant_id)
    THEN RAISE EXCEPTION 'director project ownership mismatch'; END IF;
  event_ref := COALESCE(to_jsonb(NEW)->>'source_event_id',to_jsonb(NEW)->>'grant_event_id');
  IF event_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM biz_events e WHERE e.tenant_id=NEW.tenant_id
    AND e.workspace_id=NEW.workspace_id AND e.event_id=event_ref)
    THEN RAISE EXCEPTION 'director event ownership mismatch'; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['video_creative_delegations','video_director_plans','video_director_jobs','video_director_preferences','video_director_audio_sources','video_director_choices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id=current_setting(''app.tenant_id'',true) AND workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true) AND workspace_id=current_setting(''app.workspace_id'',true))',name||'_scope',name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION video_director_scope_guard()',name||'_scope_guard',name);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO workloom_app,workloom_gateway',name);
  END LOOP;
END $$;
GRANT UPDATE ON video_director_jobs TO workloom_app,workloom_gateway;
