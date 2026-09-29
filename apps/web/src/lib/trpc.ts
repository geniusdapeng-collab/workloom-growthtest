/**
 * tRPC client（v11，httpBatchLink；类型由 @workloom/server 端到端推导——总纲 §2.4）
 * 轮询口径（F3.4/D6）：线程/夜班 5s，其余 10–15s（P1 接线起生效）
 * 鉴权：演示身份 JWT（B5）——token 存 localStorage；无 token 时 P1 以种子成员自动登录
 * （演示口径；真实登录页/多端登录在后续任务卡落地，JWT_SECRET 由部署方配置）
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@workloom/server/router";
import { DEMO_MEMBER, DEMO_WORKSPACE, storageKey } from "./product";

const TOKEN_KEY = storageKey("access-token");
/**
 * 本机个人使用为**默认形态**（T-2026-0921-0002，产品所有者口径）：
 * B 端默认隐藏游客/注册入口，并以**店主（种子成员）**身份自动登录——打开即用。
 * 只有显式设置 `VITE_WORKLOOM_LOCAL_FULL=0` 才关闭（用于演示游客态与权限回归）。
 */
const LOCAL_FULL = import.meta.env.VITE_WORKLOOM_LOCAL_FULL !== "0";
/** 全量模式开关：默认开；`VITE_WORKLOOM_LOCAL_FULL=0` 时关闭（游客/试用入口恢复）。 */
export function isLocalFull(): boolean { return LOCAL_FULL; }
// 身份切换代次：显式登录开始后，较早发出的游客请求不得再覆盖正式令牌。
let identityRevision = 0;
let formalLoginEpoch = 0;
let formalLoginsInFlight = 0;

function announceIdentityChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("workloom:identity-changed"));
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  identityRevision += 1;
  localStorage.setItem(TOKEN_KEY, token);
  // setToken 只用于正式身份；游客令牌必须通过 setGuestToken 原子写入身份标记。
  localStorage.removeItem(GUEST_KEY);
  announceIdentityChange();
}
export function clearToken(): void {
  identityRevision += 1;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(GUEST_KEY);
  announceIdentityChange();
}

const REFRESH_KEY = storageKey("refresh-token");
export function getRefreshToken(): string | null { return localStorage.getItem(REFRESH_KEY); }
export function setRefreshToken(token: string): void { localStorage.setItem(REFRESH_KEY, token); }

/* ================= 身份策略（2026-09-21 产品所有者口径：取消游客只读进入） =================
 * B 端不再提供"游客（只读）"进入方式：打开即以**店主（种子成员）**身份登录，直接进生产模式。
 * 旧版本可能已在浏览器里留下游客标记——保留清理入口，登录时一并摘除，升级用户不会卡在只读态。 */
const GUEST_KEY = storageKey("guest");
/** 历史游客标记查询（新版本不再写入）。仅用于清理旧状态与登录页文案判断。 */
export function isGuest(): boolean { return localStorage.getItem(GUEST_KEY) === "1"; }
export function clearGuestFlag(): void { localStorage.removeItem(GUEST_KEY); }

let validatedToken: string | null = null;

/** 桌面升级可能轮换本机 JWT 密钥；不能只凭 localStorage 中“有字符串”判断会话有效。 */
async function validateStoredSession(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  if (validatedToken === token) return true;
  const requestRevision = identityRevision;
  try {
    await trpc.access.me.query();
    // 校验返回期间身份已变化时，结果只属于旧令牌；保留新身份并阻止游客降级。
    if (identityRevision !== requestRevision || getToken() !== token) return getToken() !== null;
    validatedToken = token;
    return true;
  } catch {
    // 旧令牌的迟到失败不能清掉并发登录刚写入的新令牌。
    if (identityRevision === requestRevision && getToken() === token) {
      clearToken();
      if (validatedToken === token) validatedToken = null;
    }
    return false;
  }
}

/**
 * 兼容别名（历史页面挂载点仍在调用）：**不再签发游客身份**。
 * 任何调用都直接落到店主登录——"打开即生产模式"的唯一入口（2026-09-21 产品所有者口径）。
 */
export async function ensureGuestSession(): Promise<void> {
  return ensureDemoLogin(DEV_DEMO_MEMBER);
}

export const trpc: ReturnType<typeof createTRPCClient<AppRouter>> = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "/trpc",
      headers: () => {
        const token = getToken();
        return token ? { authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});

/**
 * 演示身份自动登录（演示/开发便利；生产部署用真实登录替代）。
 * 工作区与成员均可经 VITE_DEMO_WORKSPACE / VITE_DEMO_MEMBER 覆盖——
 * 不写死在调用侧，客户自建工作区（非种子库默认工作区）时演示登录仍可用。
 *
 * 默认身份（2026-09-21 起）：**无参调用 = 店主（种子成员）真身份登录**；
 * 已不存在"游客（只读）进场"分支——传 memberNo 仅用于演示/权限回归时指定其他成员。
 */
export const DEV_DEMO_MEMBER = DEMO_MEMBER;
export async function ensureDemoLogin(memberNo?: string): Promise<void> {
  const target = memberNo ?? DEV_DEMO_MEMBER; // 默认店主：不再存在"无参=游客"的旧语义
  const loginEpoch = ++formalLoginEpoch;
  formalLoginsInFlight += 1;
  identityRevision += 1;
  try {
    if (!isGuest() && await validateStoredSession()) return;
    if (isGuest()) clearToken(); // 历史游客态一律清理，避免只读身份残留
    const r = await trpc.auth.loginAs.mutate({ workspaceSlug: DEMO_WORKSPACE, memberNo: target });
    if (loginEpoch !== formalLoginEpoch) return;
    setToken(r.token);
    validatedToken = r.token;
    return;
  } finally {
    formalLoginsInFlight = Math.max(0, formalLoginsInFlight - 1);
  }
}
