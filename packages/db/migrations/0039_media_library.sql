-- ============================================================================
-- 0039_media_library.sql —— 媒资素材管理模块（T-2026-0926-0007）
--   规格书：《媒资素材管理模块（Media Library）· 实施规格书 v1.0》§2
--
-- 口径：
--   - 扩展 video_assets 为媒资库主表（不新建平行表：版本链 / sha256 幂等 / RLS 全部复用）；
--   - 卫星表全部带 workspace_id + RLS（复用 0009 DO 块模式）；双角色授权（app 读写 / gateway 读写）；
--   - embedding 列与 hnsw 索引本迁移一次到位（T-2026-0926-0010 才启用，避免二次迁移）；
--   - 与规格书 DDL 的两处偏差（实现期评审结论，已在任务卡留痕）：
--       ① `video_assets` / `media_collections` / `media_collection_items` 增 `updated_at` +
--          BEFORE UPDATE 触发器。规格书 §7.2 的云端增量同步以 updated_at 为游标，
--          但这三张表原本没有该列 —— 不补则 T-2026-0926-0009 无法实现（对账/推拉无锚点）。
--       ② 卫星表策略先 `DROP POLICY IF EXISTS` 再建：规格书「全部幂等可重跑」的风险条款
--          与 DO 块里裸 `CREATE POLICY` 互斥，重跑即 42710 报错；本文件补成幂等。
--   - 只增不改：纯新增列/表/索引，回滚无需回退迁移（留表留列无害）。
-- 依赖：0001_init.sql（workspaces/tenants/双角色/pgvector）、0009_video_studio.sql（video_assets）。
-- ============================================================================

-- ---------- ① video_assets 媒资化扩展 ----------

ALTER TABLE video_assets
  ADD COLUMN IF NOT EXISTS title TEXT,                          -- 素材名（缺省 kind+日期由应用层补）
  ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]',    -- 自由标签 ["口播","产品特写"]
  ADD COLUMN IF NOT EXISTS prompt TEXT,                         -- 生成提示词摘要（冗余自 render_scripts，供检索）
  ADD COLUMN IF NOT EXISTS pipeline_kind TEXT
    CHECK (pipeline_kind IN ('narrative','marketing') OR pipeline_kind IS NULL),
  ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS width INTEGER,
  ADD COLUMN IF NOT EXISTS height INTEGER,
  ADD COLUMN IF NOT EXISTS thumb_path TEXT,                     -- 缩略图（媒体仓相对路径）
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'generated'
    CHECK (source_type IN ('generated','uploaded','imported','recut')),
  ADD COLUMN IF NOT EXISTS sync_state TEXT NOT NULL DEFAULT 'local_only'
    CHECK (sync_state IN ('local_only','syncing','synced','cloud_only','conflict')),
  ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR,
  ADD COLUMN IF NOT EXISTS embedding vector(1536),              -- T-2026-0926-0010 语义检索（kb_chunks 同口径）
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- kind 扩展为 10 类（0009 原约束为内联 CHECK，PG 自动命名 video_assets_kind_check）
ALTER TABLE video_assets DROP CONSTRAINT IF EXISTS video_assets_kind_check;
ALTER TABLE video_assets ADD CONSTRAINT video_assets_kind_check
  CHECK (kind IN ('product_image','reference_image','portrait','clip','final_cut',
                  'shot_plate','cover','upload_video','upload_image','upload_audio'));

CREATE INDEX IF NOT EXISTS idx_video_assets_tags ON video_assets USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_video_assets_tsv  ON video_assets USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_video_assets_ws_kind_status ON video_assets (workspace_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_video_assets_pipeline ON video_assets (workspace_id, pipeline_kind);
CREATE INDEX IF NOT EXISTS idx_video_assets_ws_updated ON video_assets (workspace_id, updated_at);
-- 向量索引：hnsw（kb_chunks 同口径）；embedding 全 NULL 时索引为空，无开销
CREATE INDEX IF NOT EXISTS idx_video_assets_embedding ON video_assets
  USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

-- 全文向量触发器：title(A) > prompt(B) > tags(C)
CREATE OR REPLACE FUNCTION video_assets_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', COALESCE(NEW.title,'')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.prompt,'')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(NEW.tags::text,'')), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_video_assets_tsv ON video_assets;
CREATE TRIGGER trg_video_assets_tsv BEFORE INSERT OR UPDATE OF title, prompt, tags
  ON video_assets FOR EACH ROW EXECUTE FUNCTION video_assets_tsv_update();

-- 存量行回填 tsv（UPDATE 触发器同源，触碰即算；仅未回填行命中，可重跑）
UPDATE video_assets SET title = title WHERE search_tsv IS NULL;

-- 同步游标触发器：任何 UPDATE 都推进 updated_at（T-2026-0926-0009 增量拉取锚点）
CREATE OR REPLACE FUNCTION video_assets_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_video_assets_touch ON video_assets;
CREATE TRIGGER trg_video_assets_touch BEFORE UPDATE ON video_assets
  FOR EACH ROW EXECUTE FUNCTION video_assets_touch_updated_at();

-- pg_trgm：中文短串相似度兜底（复用匹配与全文降级用）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- 中文语料实测：`simple` 分词对中文整句几乎零命中，trgm 是中文检索的实际主路。
-- 索引既覆盖 prompt（复用匹配）也覆盖 title（列表页搜素材名）。
CREATE INDEX IF NOT EXISTS idx_video_assets_prompt_trgm ON video_assets USING GIN (prompt gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_video_assets_title_trgm ON video_assets USING GIN (title gin_trgm_ops);

-- ---------- ② 受管标签 ----------

CREATE TABLE IF NOT EXISTS media_tags (
  id           TEXT PRIMARY KEY,                 -- newId("MT")
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL,
  group_name   TEXT NOT NULL DEFAULT 'default',  -- 题材/风格/平台/商品/自定义
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, group_name, name)
);

-- ---------- ③ 合集/片单（本地重剪的组织单元） ----------

CREATE TABLE IF NOT EXISTS media_collections (
  id           TEXT PRIMARY KEY,                 -- newId("MC")
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title        TEXT NOT NULL,
  purpose      TEXT NOT NULL DEFAULT 'recut'
    CHECK (purpose IN ('recut','favorite','campaign','archive')),
  meta         JSONB NOT NULL DEFAULT '{}',      -- {targetDuration, aspectRatio, notes}
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','used','archived')),
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS media_collection_items (
  collection_id TEXT NOT NULL REFERENCES media_collections(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  asset_id      TEXT NOT NULL REFERENCES video_assets(id),
  seq           INTEGER NOT NULL,                -- 片单顺序 = 重剪镜头顺序
  note          TEXT,
  added_by      TEXT NOT NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_mci_ws ON media_collection_items (workspace_id, collection_id, seq);
CREATE INDEX IF NOT EXISTS idx_mc_ws_updated ON media_collections (workspace_id, updated_at);

-- ---------- ④ 商品档案 PG 投影（dossier 文件仍是本体，表是发现面） ----------

CREATE TABLE IF NOT EXISTS media_product_profiles (
  id             TEXT PRIMARY KEY,               -- newId("MP")
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  product_name   TEXT NOT NULL,
  dossier_path   TEXT NOT NULL,                  -- dossiers/<ws>/<product_id>/ 相对 .vm-work 路径
  dossier_sha256 TEXT NOT NULL,                  -- dossier.json 内容指纹（漂移对账）
  summary        JSONB NOT NULL DEFAULT '{}',    -- {brand, category, sellingPoints[], confidence}
  hero_asset_id  TEXT REFERENCES video_assets(id),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','archived')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, product_name)
);
CREATE INDEX IF NOT EXISTS idx_mpp_ws_updated ON media_product_profiles (workspace_id, updated_at);

-- ---------- ⑤ 云端同步台账（T-2026-0926-0009 启用，先建表） ----------

CREATE TABLE IF NOT EXISTS media_sync_log (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  asset_id     TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('push','pull')),
  payload_kind TEXT NOT NULL CHECK (payload_kind IN ('metadata','file')),
  bytes        BIGINT NOT NULL DEFAULT 0,
  peer         TEXT NOT NULL,                    -- device_id / 'cloud'
  status       TEXT NOT NULL CHECK (status IN ('done','failed')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_sync_ws ON media_sync_log (workspace_id, created_at DESC);

-- 设备登记（T-2026-0926-0009）：只存设备身份与状态，**不存设备密钥**——
-- 设备密钥由服务端主密钥确定性派生（HMAC(master, deviceId)），校验侧现算现比，
-- 因此库内没有任何长期共享密钥material；吊销即置 status='revoked'。
CREATE TABLE IF NOT EXISTS media_sync_devices (
  id           TEXT PRIMARY KEY,                 -- newId("SD")
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  label        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_seen_at TIMESTAMPTZ,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msd_ws ON media_sync_devices (workspace_id, status);

-- 合集/条目游标触发器（同 video_assets 口径：同步增量以 updated_at 为锚）
CREATE OR REPLACE FUNCTION media_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_media_collections_touch ON media_collections;
CREATE TRIGGER trg_media_collections_touch BEFORE UPDATE ON media_collections
  FOR EACH ROW EXECUTE FUNCTION media_touch_updated_at();
DROP TRIGGER IF EXISTS trg_mci_touch ON media_collection_items;
CREATE TRIGGER trg_mci_touch BEFORE UPDATE ON media_collection_items
  FOR EACH ROW EXECUTE FUNCTION media_touch_updated_at();

-- ---------- 授权与 RLS（复用 0009 DO 块模式；video_assets 已有 RLS 不重复） ----------

GRANT SELECT, INSERT, UPDATE, DELETE ON media_tags, media_collections, media_collection_items,
  media_product_profiles, media_sync_log, media_sync_devices TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON media_tags, media_collections, media_collection_items,
  media_product_profiles, media_sync_log, media_sync_devices TO workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE media_sync_log_id_seq TO workloom_app;
GRANT USAGE, SELECT ON SEQUENCE media_sync_log_id_seq TO workloom_gateway;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['media_tags','media_collections','media_collection_items',
                           'media_product_profiles','media_sync_log','media_sync_devices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- 幂等：策略先删后建（重跑迁移不因 42710 失败；策略语义不变）
    EXECUTE format('DROP POLICY IF EXISTS p_%I_ws ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY p_%I_ws ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t, t);
  END LOOP;
END $$;
