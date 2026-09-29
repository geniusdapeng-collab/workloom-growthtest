-- ============================================================================
-- 0043_whiteboard.sql —— 手绘白板解说引擎（T-2026-0926-0020）
--   上游引擎：vendor/srt-whiteboard（geeklee/srt-whiteboard-animation @696a724，MIT）
--   规格来源：《SRT 白板手绘动画接入评估与实施规格 v1.0》§2.2 + 实施期修正
--
-- 与规格书 §2.2 的三处偏差（实施期评审结论，任务卡已留痕）：
--   ① 规格书写的是 `0041_whiteboard.sql` —— 0041 已被 `0041_media_sync_device_expiry.sql`
--      占用（T-2026-0926-0016），随后 0042 又被 media_quality_followups 占用（T-2026-0926-0017），本文件改号 **0043**，避免迁移顺序冲突。
--   ② 规格书的迁移块用裸 `CREATE POLICY`（重跑即 42710 报错），违反本仓 0039 已确立的
--      「迁移幂等可复跑」口径（db-gate 会幂等复跑迁移）。本文件改为先 `DROP POLICY IF EXISTS`
--      再建，并用 DO 块 + `FOREACH` 统一处理，与 0038/0039 完全同构。
--   ③ 规格书只改 `video_projects.kind`；实测 `video_assets.pipeline_kind` 的 CHECK 只允许
--      ('narrative','marketing')，口播解说片入库时会撞约束（0039 建立）。本文件一并扩展，
--      否则媒资库无法如实标注片型。
--
-- 口径：纯新增表 + 约束扩展（只增不改语义）；回滚无需回退迁移（留表留列无害）。
-- 依赖：0001_init.sql（workspaces/双角色）、0009_video_studio.sql（video_projects/video_assets）、
--      0039_media_library.sql（video_assets.pipeline_kind）、0038_production_archive.sql（范例）。
-- ============================================================================

-- ---------- ① 项目类型：补 explainer（口播解说片） ----------
-- 0009 的内联 CHECK 由 PG 自动命名为 video_projects_kind_check；0039/0040 均未扩展它，
-- 因此这里必须真正重建约束（规格书「0040 已加 explainer 时跳过」的假设不成立）。
ALTER TABLE video_projects DROP CONSTRAINT IF EXISTS video_projects_kind_check;
ALTER TABLE video_projects ADD CONSTRAINT video_projects_kind_check
  CHECK (kind IN ('narrative','marketing','account_ops','explainer'));

-- ---------- ② 媒资库片型：补 explainer ----------
ALTER TABLE video_assets DROP CONSTRAINT IF EXISTS video_assets_pipeline_kind_check;
ALTER TABLE video_assets ADD CONSTRAINT video_assets_pipeline_kind_check
  CHECK (pipeline_kind IN ('narrative','marketing','explainer') OR pipeline_kind IS NULL);

-- ---------- ③ 白板片（1:1 video_projects）：口播稿 / 配音 / SRT / 线稿策略 / 成片回链 ----------
-- 为什么单独建表而不是塞进 video_projects.prd：prd 是 G4 的时长唯一权威（JSON 契约），
-- 白板片的运行态（配音文件、SRT 全文、渲染档位、最终成片资产）属于执行面，混进 prd 会污染契约。
CREATE TABLE IF NOT EXISTS whiteboard_films (
  id              TEXT PRIMARY KEY,               -- newId("WF")
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  project_id      TEXT NOT NULL REFERENCES video_projects(id),
  script_md       TEXT NOT NULL DEFAULT '',       -- 口播稿正文（分句的唯一事实源）
  narration_path  TEXT,                           -- 配音 WAV（媒体仓相对路径）
  narration_profile TEXT,                         -- 音色档案（配音工位 profiles/<name>）
  -- 配音进度：本机克隆音色引擎单句 80–220s，30 句就是几十分钟的活，必须是**可观察的异步任务**
  -- （同步 HTTP 请求会被 undici 的 300s 头超时打断，真机踩到过）
  narration_done  INTEGER NOT NULL DEFAULT 0,
  narration_total INTEGER NOT NULL DEFAULT 0,
  narration_note  TEXT,                           -- 当前正在合成的句子（人类可读进度）
  srt             TEXT NOT NULL DEFAULT '',       -- 全片 SRT（由逐句真实时长生成）
  lineart_mode    TEXT NOT NULL DEFAULT 'seedream'
                  CHECK (lineart_mode IN ('seedream','sketch','upload')),
  render_fps      INTEGER NOT NULL DEFAULT 30,
  cap_long_edge   INTEGER NOT NULL DEFAULT 1280,
  voice_lufs      NUMERIC(6,2) NOT NULL DEFAULT -16.00,
  final_asset_id  TEXT REFERENCES video_assets(id),
  final_path      TEXT,                           -- 混流成片（媒体仓相对路径）
  status          TEXT NOT NULL DEFAULT 'draft'
                  -- 与 whiteboardRouter 的状态机逐值对齐（含长任务中间态 narrating：
                  -- 配音是几十分钟的异步任务，"在配音中"必须是一个可观察的合法状态）
                  CHECK (status IN ('draft','narrating','narrated','planned','lineart',
                                    'annotated','rendered','delivered','failed')),
  error_msg       TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id)
);

-- ---------- ④ 白板多幕场景（一项目 N 幕；标注随场景行更新，保护现场可重渲） ----------
CREATE TABLE IF NOT EXISTS whiteboard_scenes (
  id             TEXT PRIMARY KEY,               -- newId("WS")
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  project_id     TEXT NOT NULL REFERENCES video_projects(id),
  scene_no       INTEGER NOT NULL,                -- 幕序（与字幕分幕一致，1 起）
  title          TEXT NOT NULL DEFAULT '',
  core_idea      TEXT NOT NULL DEFAULT '',        -- 这一幕只表达的一个核心意思
  cue_start_ms   INTEGER NOT NULL DEFAULT 0,      -- 本幕字幕起（毫秒）
  cue_end_ms     INTEGER NOT NULL DEFAULT 0,      -- 本幕字幕止（毫秒）
  lineart_path   TEXT,                            -- 线稿 PNG（媒体仓相对路径）
  lineart_source TEXT CHECK (lineart_source IN ('seedream','sketch','upload') OR lineart_source IS NULL),
  lineart_prompt TEXT,                            -- 实际下发的出图提示词（可复现）
  lineart_check  JSONB NOT NULL DEFAULT '{}',     -- 风格机检读数（背景色/深色占比/连通域数）
  annotation     JSONB NOT NULL DEFAULT '{}',     -- annotation.json 全文（上游 README 契约）
  subtitle_srt   TEXT NOT NULL DEFAULT '',        -- 本幕字幕段
  duration_ms    INTEGER,                         -- = cue_end_ms - cue_start_ms（渲染总时长）
  clip_path      TEXT,                            -- 本幕静音 MP4（媒体仓相对路径）
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','lineart','annotated','confirmed','rendered','failed')),
  error_msg      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id, scene_no)
);
CREATE INDEX IF NOT EXISTS idx_ws_project ON whiteboard_scenes (workspace_id, project_id, scene_no);
CREATE INDEX IF NOT EXISTS idx_wb_films_ws_status ON whiteboard_films (workspace_id, status);

-- ---------- ⑤ 同步游标触发器（与 0039 同口径：updated_at 是增量同步锚点） ----------
CREATE OR REPLACE FUNCTION whiteboard_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_whiteboard_films_touch ON whiteboard_films;
CREATE TRIGGER trg_whiteboard_films_touch BEFORE UPDATE ON whiteboard_films
  FOR EACH ROW EXECUTE FUNCTION whiteboard_touch_updated_at();

DROP TRIGGER IF EXISTS trg_whiteboard_scenes_touch ON whiteboard_scenes;
CREATE TRIGGER trg_whiteboard_scenes_touch BEFORE UPDATE ON whiteboard_scenes
  FOR EACH ROW EXECUTE FUNCTION whiteboard_touch_updated_at();

-- ---------- ⑥ 授权与 RLS（复用 0009/0038 DO 块模式；策略先删后建保证幂等） ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON whiteboard_films, whiteboard_scenes TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON whiteboard_films, whiteboard_scenes TO workloom_gateway;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['whiteboard_films','whiteboard_scenes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS p_%I_ws ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY p_%I_ws ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t);
  END LOOP;
END $$;
