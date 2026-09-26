-- ============================================================================
-- 0038_production_archive.sql —— 制片档案：环节执行台账 + 工程发现
--   （T-2026-0926-0001 · 规格书《制片档案与运维闭环机制 v1.0》§4）
--
-- 口径：
--   - 档案本体在文件系统（`.vm-work/archive/<workspaceId>/<projectId>/`），本文件只建**查询面/索引面**；
--     以 project_id + stage_id + attempt 与档案文件关联，不搬运大产物。
--   - 全部带 workspace_id + RLS（复用 0009 DO 块模式）；双角色授权（app 读写 / gateway 读写）。
--   - 业务语义事件仍走 biz_events（append-only，不在本文件）；档案过程事件只进档案夹 events.jsonl。
--   - 只增不改：纯新增两张表，回滚无需回退迁移（留表无害）。
--   - 与规格书 DDL 的两处差异（已在任务卡留痕）：
--     ① 增 `last_heartbeat_at`：僵死判定需要在 PG 查询面一条 SQL 判「running 且久无心跳」，
--        否则监控器必须逐项目读 events.jsonl（文件是本体，但巡检不能靠 N 次开文件）。
--     ② 增 `attempt >= 1` 约束：attempt 是幂等键组成部分，0/负值属非法输入，直接由 DB 挡。
-- 依赖：0001_init.sql（workspaces/tenants/双角色）、0009_video_studio.sql（video_projects）。
-- ============================================================================

-- ---------- 环节执行台账（监控 / 看板 / 断点续跑的数据源） ----------

CREATE TABLE production_stage_runs (
  id               TEXT PRIMARY KEY,                 -- newId("SR")
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  project_id       TEXT NOT NULL REFERENCES video_projects(id),
  stage_id         TEXT NOT NULL,                    -- stage-registry 的 29 个 id + 渲染/后期/交付段环节
  attempt          INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status           TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','done','failed','skipped','interrupted')),
  input_ref        TEXT,                             -- 档案相对路径 stages/<stage>/attempt-<n>.input.json
  output_ref       TEXT,                             -- 档案相对路径 stages/<stage>/attempt-<n>.output.json
  output_sha256    TEXT,                             -- 产物摘要（对账：文件 vs 台账漂移）
  error_class      TEXT,                             -- NETWORK/LLM_*/PROVIDER_*/SESSION/GATE_REJECTED/BUG
  error_msg        TEXT,                             -- 摘要（<=500 字；堆栈只进 attempt-<n>.meta.json）
  duration_ms      INTEGER,
  cost             JSONB NOT NULL DEFAULT '{}',      -- {tokens, cashCny}
  run_id           TEXT,                             -- 关联 RunEntry.runId，便于与内存投影对账
  last_heartbeat_at TIMESTAMPTZ,                     -- 长环节进度心跳（僵死判定用；无心跳为 NULL）
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  UNIQUE (workspace_id, project_id, stage_id, attempt)   -- attempt 唯一 = 台账写入幂等
);

CREATE INDEX idx_psr_ws_status   ON production_stage_runs (workspace_id, status);
CREATE INDEX idx_psr_project     ON production_stage_runs (workspace_id, project_id, stage_id);
CREATE INDEX idx_psr_running_age ON production_stage_runs (started_at) WHERE status = 'running';
CREATE INDEX idx_psr_ws_heartbeat ON production_stage_runs (workspace_id, last_heartbeat_at)
  WHERE status = 'running';

-- ---------- 工程发现（第二类数据闭环：日志监控 → 工程发现 → 修复 → 沉淀） ----------

CREATE TABLE engineering_findings (
  id            TEXT PRIMARY KEY,                    -- newId("EF")
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  category      TEXT NOT NULL
                CHECK (category IN ('bug','optimization','new_solution','experience')),
  severity      TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  source        TEXT NOT NULL
                CHECK (source IN ('archive_watch','pipeline_audit','runtime_log','human')),
  project_id    TEXT,                                -- 可空：纯代码问题不挂片子
  stage_id      TEXT,
  title         TEXT NOT NULL,
  evidence      JSONB NOT NULL DEFAULT '{}',         -- {logPaths[], errorClass, occurrences, archiveRoot}
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','triaged','fixing','fixed','distilled','wontfix')),
  task_ref      TEXT,                                -- CNB 任务卡 T-YYYY-MMDD-XXXX
  fix_ref       TEXT,                                -- PR 号 / commit sha
  distilled_to  TEXT,                                -- docs/badcases/ 路径
  dedupe_key    TEXT,                                -- category+errorClass+stageId 聚类去重（写入侧恒非空）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  UNIQUE (workspace_id, dedupe_key)                  -- 同类问题只开一张单，occurrences 累加
);

CREATE INDEX idx_ef_ws_status ON engineering_findings (workspace_id, status);
CREATE INDEX idx_ef_ws_project ON engineering_findings (workspace_id, project_id);

-- ============================================================================
-- 权限（模仿 0009）：app/gateway 双角色读写；biz_events 不在本文件。
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON production_stage_runs, engineering_findings TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON production_stage_runs, engineering_findings TO workloom_gateway;

-- ============================================================================
-- RLS 行级隔离（模仿 0009 DO 块）：按 app.workspace_id 连接级设置过滤；
-- 未设置时所有行不可见（安全默认值）；越权查询返回空而非 403（L7.1）。
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['production_stage_runs','engineering_findings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%I_ws ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t);
  END LOOP;
END $$;
