-- ============================================================================
-- 0041_media_sync_device_expiry.sql —— 设备凭证过期（T-2026-0926-0016）
-- 深审发现：media_sync_devices 只有 status，没有过期时间；设备密钥由主密钥派生、
-- 永不失效，签发者（甚至 staff 角色）离职后凭证仍然可用，只能人工 revoke。
-- 本迁移补 expires_at（缺省 90 天，可被 enroll 覆盖）+ 过期索引；纯增列，可重复执行。
-- ============================================================================
ALTER TABLE media_sync_devices
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days');

CREATE INDEX IF NOT EXISTS idx_msd_ws_active
  ON media_sync_devices (workspace_id, expires_at)
  WHERE status = 'active';
