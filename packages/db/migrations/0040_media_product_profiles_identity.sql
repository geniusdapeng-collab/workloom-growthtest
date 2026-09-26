-- ============================================================================
-- 0040_media_product_profiles_identity.sql —— 商品档案稳定身份（T-2026-0926-0015）
--
-- 深审发现：media_product_profiles 的唯一键是 (workspace_id, product_name)，
-- 而 product_name 来自 dossier.identity.name —— 商品改名会**新建一行**、旧行残留，
-- 且 UI 的"单卡重扫"以商品名做 productId（目录名是 PRD-xxx）必然 404。
--
-- 本迁移补一个稳定身份列 dossier_product_id（= dossier 目录名，dossier_path 的 basename），
-- 并对它建唯一索引；改名只更新同一行，重扫/对账都以目录名为主键。
-- 纯增列 + 增索引（WHERE 部分索引），历史行按 dossier_path 回填，可重复执行。
-- ============================================================================

ALTER TABLE media_product_profiles
  ADD COLUMN IF NOT EXISTS dossier_product_id TEXT;

UPDATE media_product_profiles
   SET dossier_product_id = NULLIF(regexp_replace(dossier_path, '.*/', ''), '')
 WHERE dossier_product_id IS NULL AND dossier_path <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_mpp_ws_dossier_product
  ON media_product_profiles (workspace_id, dossier_product_id)
  WHERE dossier_product_id IS NOT NULL;
