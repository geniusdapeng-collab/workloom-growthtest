-- ============================================================================
-- 0040_talkcraft_explainer.sql —— 口播解说片（talkcraft-explainer）· T-2026-0926-0008
--   规格书：《口播解说片能力（talkcraft-explainer）· 实施规格书 v2.0》§4
--
-- 口径：
--   - 只增不改列：kind 约束扩一个取值（explainer），新增一张版本链表 explainer_shotbooks；
--   - shotbook 列存层矩阵结构化分镜（Zod schema 见 apps/server/src/video/explainer/types.ts），
--     markdown 版 SHOTBOOK 由应用层渲染进制片档案供人读，不进本表；
--   - timestamps_ref 存工程相对路径的 audio/timestamps.json（schema 见 explainer/asr-aligner.ts）；
--   - 版本链：同 (workspace, project) 下 version 单调递增，单镜返修走新版本 + render_scope
--     记录本次重渲范围（--changed s07 的审计依据）；
--   - 全部带 workspace_id + RLS（复用 0009 DO 块模式）；双角色授权（app 读写 / gateway 读写）；
--   - 幂等可重跑：约束先 DROP IF EXISTS 再 ADD，策略先 DROP POLICY IF EXISTS 再建
--     （0039 已踩过裸 CREATE POLICY 重跑 42710 的坑）。
-- 依赖：0001_init.sql（workspaces/双角色）、0009_video_studio.sql（video_projects/render_scripts）、
--       0039_media_library.sql（video_assets.pipeline_kind）。
-- ============================================================================

-- ---------- ① kind 扩 'explainer' ----------

-- video_projects.kind：0009 内联 CHECK 自动命名 video_projects_kind_check
ALTER TABLE video_projects DROP CONSTRAINT IF EXISTS video_projects_kind_check;
ALTER TABLE video_projects ADD CONSTRAINT video_projects_kind_check
  CHECK (kind IN ('narrative','marketing','account_ops','explainer'));

-- video_assets.pipeline_kind：0039 内联 CHECK 自动命名 video_assets_pipeline_kind_check
ALTER TABLE video_assets DROP CONSTRAINT IF EXISTS video_assets_pipeline_kind_check;
ALTER TABLE video_assets ADD CONSTRAINT video_assets_pipeline_kind_check
  CHECK (pipeline_kind IN ('narrative','marketing','explainer') OR pipeline_kind IS NULL);

-- ---------- ② 口播分镜书（SHOTBOOK）版本链 ----------

CREATE TABLE IF NOT EXISTS explainer_shotbooks (
  id                TEXT PRIMARY KEY,                    -- newId("ESB")
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  project_id        TEXT NOT NULL REFERENCES video_projects(id),
  version           INTEGER NOT NULL CHECK (version >= 1),
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','validated','rendered','delivered','failed')),
  script_text       TEXT NOT NULL,                       -- 口播稿原文（TTS 输入；数字须汉字化）
  script_sha256     TEXT NOT NULL,                       -- 口播稿指纹（幂等 + 漂移检测）
  shotbook          JSONB NOT NULL,                      -- 层矩阵结构化分镜（Zod schema）
  timestamps_ref    TEXT,                                -- audio/timestamps.json
  timing_ref        TEXT,                                -- remotion/src/timing.json
  audio_ref         TEXT,                                -- audio/full.wav
  job_dir           TEXT,                                -- var/talkcraft-jobs/<taskId>
  engine_pin        JSONB NOT NULL DEFAULT '{}',         -- {commit, runtimeVersion, cards[]}
  render_scope      JSONB NOT NULL DEFAULT '{"mode":"full"}',
  qa_report         JSONB,                               -- 机器闸六条 + 独立评审结论快照
  voice_ref         JSONB NOT NULL DEFAULT '{}',         -- {source:'tts'|'upload', profileId, sha256}
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, version)
);

CREATE INDEX IF NOT EXISTS idx_explainer_shotbooks_project
  ON explainer_shotbooks (workspace_id, project_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_explainer_shotbooks_status
  ON explainer_shotbooks (workspace_id, status);

-- updated_at 触发器（与 0039 media_touch_updated_at 同口径，独立命名避免跨文件依赖）
CREATE OR REPLACE FUNCTION explainer_shotbooks_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_explainer_shotbooks_touch ON explainer_shotbooks;
CREATE TRIGGER trg_explainer_shotbooks_touch
  BEFORE UPDATE ON explainer_shotbooks
  FOR EACH ROW EXECUTE FUNCTION explainer_shotbooks_touch_updated_at();

-- ---------- ③ 授权与 RLS（0009 DO 块模式） ----------

GRANT SELECT, INSERT, UPDATE, DELETE ON explainer_shotbooks TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON explainer_shotbooks TO workloom_gateway;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['explainer_shotbooks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS p_%I_ws ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY p_%I_ws ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t, t);
  END LOOP;
END $$;
