import { timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";

/** Public demo impersonation is a development tool, never a production identity source. */
export function assertDemoLoginAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production") {
    throw new TRPCError({ code: "FORBIDDEN", message: "请使用账户登录或受信任的本机客户端登录" });
  }
}

/** The bootstrap capability lives only in the main/server processes, not in web assets or .env. */
export function desktopLoginTarget(headers: Headers, env: NodeJS.ProcessEnv = process.env): { workspaceSlug: string; memberNo: string } {
  const expected = env.WORKLOOM_DESKTOP_LOGIN_KEY ?? "";
  const supplied = headers.get("x-workloom-desktop-key") ?? "";
  const workspaceSlug = env.WORKLOOM_DESKTOP_WORKSPACE;
  const memberNo = env.WORKLOOM_DESKTOP_MEMBER;
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(supplied)
    || env.SERVER_HOST !== "127.0.0.1" || !workspaceSlug || !memberNo
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "本机登录凭证无效或部署未启用可信本机登录" });
  }
  return { workspaceSlug, memberNo };
}
