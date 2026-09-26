-- ============================================================================
-- 0042_media_quality_followups.sql —— 媒资库质量跟进（T-2026-0926-0017）
-- ① 列表/成片历史的排序索引：`WHERE workspace_id=? ORDER BY created_at DESC, id DESC LIMIT n`
--    在 5k 行实测走 Seq Scan + Sort（深审计划证据）。
-- ② updated_at 触发器支持 `app.skip_media_touch=1` 事务级豁免：向量回填不该制造"新变更"
--    （否则每跑一次 media-embed 都会把全量素材标脏，同步/冲突噪声爆炸）。
-- 纯增索引 + 函数替换，可重复执行。
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_video_assets_ws_created
  ON video_assets (workspace_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION video_assets_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.skip_media_touch', true) = '1' THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION media_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.skip_media_touch', true) = '1' THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
