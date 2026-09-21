/**
 * 真实数据源（P3）：从 growthtest 本地 server 的 tRPC 只读接口取 roster / theater。
 *
 * 口径：
 *  - 只读查询，不写业务库；token 通过演示登录获取，仅保存在进程内存；
 *  - 失败不阻断：调用方保留本地 store/夹具投影，并显式标注 live.error；
 *  - 只用于本机回环 HTTP（默认 http://127.0.0.1:9397/trpc）。
 */

export function createLiveSource({
  trpcUrl = process.env.WORKLOOM_TRPC_URL ?? "",
  workspaceSlug = process.env.WORKLOOM_TRPC_WORKSPACE ?? "geo-growth",
  memberNo = process.env.WORKLOOM_TRPC_MEMBER ?? "MEM-G01",
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  if (!trpcUrl) return null;
  const base = trpcUrl.replace(/\/$/, "");
  let token = null;

  async function withTimeout(promise, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await promise(controller.signal);
    } catch (error) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function login() {
    return withTimeout(async (signal) => {
      const response = await fetchImpl(`${base}/auth.loginAs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug, memberNo }),
        signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      const next = payload?.result?.data?.token;
      if (!next) throw new Error("loginAs 未返回 token");
      token = next;
      return next;
    }, "auth.loginAs");
  }

  async function query(path, input = {}) {
    const run = async (authToken) =>
      withTimeout(async (signal) => {
        const url = `${base}/${path}?input=${encodeURIComponent(JSON.stringify(input))}`;
        const response = await fetchImpl(url, {
          headers: { authorization: `Bearer ${authToken}` },
          signal,
        });
        const payload = await response.json();
        if (!response.ok) {
          const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return payload?.result?.data;
      }, path);
    if (!token) await login();
    try {
      return await run(token);
    } catch (error) {
      if (error?.status === 401) {
        await login();
        return run(token);
      }
      throw error;
    }
  }

  return {
    url: base,
    workspaceSlug,
    memberNo,
    roster: () => query("roster.list"),
    theater: () => query("captain.theater"),
    async load() {
      const fetchedAt = new Date().toISOString();
      try {
        const [roster, theater] = await Promise.all([query("roster.list"), query("captain.theater")]);
        return { ok: true, roster, theater, fetchedAt, url: base };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), fetchedAt, url: base };
      }
    },
  };
}
