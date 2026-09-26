-- 视频生成完整接入（T-2026-0921-0002）：多供应商 / 报价与实际成本 / 幂等 / 成片入库回链
--
-- 口径：只增列不改列（历史行保持可读）；render_jobs 既有 RLS 策略与双角色授权随之生效，
--      新增列不需要额外 GRANT（表级授权已覆盖）。
-- 依赖：0009_video_studio.sql（render_jobs 基础表）。

ALTER TABLE render_jobs
  ADD COLUMN IF NOT EXISTS provider        TEXT,          -- 实际使用的供应商（seedance/higgsfield/kling/jimeng/muapi）
  ADD COLUMN IF NOT EXISTS provider_model  TEXT,          -- 实际使用的模型 id（目录口径）
  ADD COLUMN IF NOT EXISTS est_usd         NUMERIC(12,4), -- 提交前预估（USD）
  ADD COLUMN IF NOT EXISTS est_cny         NUMERIC(12,4), -- 提交前预估（CNY，按 VIDEO_USD_CNY_RATE 折算）
  ADD COLUMN IF NOT EXISTS actual_usd      NUMERIC(12,4), -- 完成后实际（USD；供应商未回报时按预估口径回填并标注）
  ADD COLUMN IF NOT EXISTS actual_cny      NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS est_seconds     INTEGER,       -- 预估秒数（额度台账口径）
  ADD COLUMN IF NOT EXISTS actual_seconds  INTEGER,       -- 供应商回执秒数（缺失为空，不臆造）
  ADD COLUMN IF NOT EXISTS status_url      TEXT,          -- 供应商状态查询地址（Higgsfield 返回；留痕便于排障）
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,          -- 幂等键（同键重复提交直接返回既有 job）
  ADD COLUMN IF NOT EXISTS asset_id        TEXT,          -- 成片入库后的 video_assets.id（回链）
  ADD COLUMN IF NOT EXISTS attempt         INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS mock            BOOLEAN NOT NULL DEFAULT false, -- 演示与真实分明（不变量 9）
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- 幂等：同工作区同幂等键只允许一条（NULL 不受限，兼容历史行）
CREATE UNIQUE INDEX IF NOT EXISTS uq_render_jobs_ws_idem
  ON render_jobs (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 排障：按供应商任务号反查（回执核对）
CREATE INDEX IF NOT EXISTS idx_render_jobs_ws_provider_task
  ON render_jobs (workspace_id, provider, task_id);
