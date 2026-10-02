-- 0052 · 号源回归纯序列（GR-02 第二次收口）
--
-- 0050 的复盘（2026-09-29 第三方独立验收实证）：
--   `GREATEST(nextval, (SELECT max(...)))` 把 0048 刚刚拿到的原子性又交还给了 max 竞争——
--   max 子查询只见**已提交**行，两个并发事务各自 nextval（101、102）却读到同一个 max（103）
--   → GREATEST 同为 103 → 应用层 +1 后同为 T-104 → duplicate key。
--   实测：12 路并发派遣 11 成功 + 1 个 500（`current transaction is aborted`），
--   且该重试写在已中止事务内，从诞生起就不可能成功。
--
-- 本次口径：
--   ① 取号函数**只做 nextval**，不读任何业务表——一个 nextval 一个号，返回值直接可用；
--   ② "序列落后于手写/历史 id"的问题在**源头**解决：迁移末尾与种子脚本收尾各做一次
--      `setval(seq, GREATEST(现值, 现存最大号))`（只抬不降，幂等）；
--   ③ 极小概率仍撞号（迁移后又有人手写高位 id）→ 应用层 `insertWithReadableId`
--      用 SAVEPOINT 换号重试（同事务内，不回滚整事务）。

CREATE OR REPLACE FUNCTION public.threads_max_t_no()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$ SELECT nextval('public.thread_no_seq')::bigint $$;

CREATE OR REPLACE FUNCTION public.video_projects_max_vid_no()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$ SELECT nextval('public.video_project_no_seq')::bigint $$;

-- 迁移期对齐：把已经存在的（种子/手写/历史）号段一次性越过，之后取号不再撞库。
SELECT setval(
  'public.thread_no_seq',
  GREATEST(
    (SELECT last_value FROM public.thread_no_seq),
    (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 100)
       FROM public.threads WHERE id ~ '^T-[0-9]+$')
  ),
  true
);

SELECT setval(
  'public.video_project_no_seq',
  GREATEST(
    (SELECT last_value FROM public.video_project_no_seq),
    (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 1000)
       FROM public.video_projects WHERE id ~ '^VID-[0-9]+$')
  ),
  true
);

GRANT EXECUTE ON FUNCTION public.threads_max_t_no() TO workloom_app, workloom_gateway;
GRANT EXECUTE ON FUNCTION public.video_projects_max_vid_no() TO workloom_app, workloom_gateway;
