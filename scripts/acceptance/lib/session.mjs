/**
 * session.mjs · 验收器成员会话建立（RDAS v3.0）
 *
 * 背景（真实踩坑）：演示直登默认走**游客**（readonly，且服务端会删除 approvals.read）；
 * 只往 legacy key `workloom:access-token` 注入成员 token，会被 `workloom:<product>:b-pc:guest=1`
 * 覆盖 → 审批页被判“当前身份不能访问此页面”，验收器把**自己的会话问题**误判成产品缺陷。
 *
 * 正确做法：写入产品作用域 key、清除 guest 标记、reload 后用 access.me 自证成员身份。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function productIdOf(repoRoot) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, "product.manifest.json"), "utf-8")).productId ?? "workloom-im";
  } catch {
    return "workloom-im";
  }
}

export async function loginAsMember(page, { urls, workspaceSlug, memberNo = "MEM-001", productId = "workloom-im" }) {
  const res = await page.request.post(`${urls.api}/trpc/auth.loginAs`, {
    data: { workspaceSlug, memberNo },
  });
  const json = await res.json();
  const token = json?.result?.data?.token;
  if (!token) throw new Error(`登录失败（loginAs）：${JSON.stringify(json).slice(0, 200)}`);

  await page.goto(`${urls.pc}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await page.evaluate(({ t, pid, slug }) => {
    const tokenKey = `workloom:${pid}:b-pc:access-token`;
    const guestKey = `workloom:${pid}:b-pc:guest`;
    localStorage.setItem(tokenKey, t);
    localStorage.removeItem(guestKey);
    localStorage.setItem("workloom:access-token", t);
    if (slug) localStorage.setItem(`workloom:${pid}:b-pc:workspace`, slug);
    for (const key of Object.keys(localStorage)) {
      if (key.endsWith(":guest")) localStorage.removeItem(key);
      if (key.endsWith(":access-token") && key !== tokenKey) localStorage.setItem(key, t);
    }
  }, { t: token, pid: productId, slug: workspaceSlug });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const session = await page.evaluate(async (api) => {
    const tokenKey = Object.keys(localStorage).find((key) => key.endsWith(":access-token"));
    const token = tokenKey ? localStorage.getItem(tokenKey) : null;
    const response = await fetch(`${api}/trpc/access.me`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const body = await response.json().catch(() => ({}));
    return {
      status: response.status,
      subject: body?.result?.data?.subject ?? null,
      guestFlags: Object.keys(localStorage).filter((key) => key.endsWith(":guest")),
    };
  }, urls.api);

  if (session.status !== 200 || session.subject?.memberNo !== memberNo || session.guestFlags.length > 0) {
    throw new Error(`成员会话建立失败（可能被游客会话覆盖）：${JSON.stringify(session).slice(0, 300)}`);
  }
  return token;
}
