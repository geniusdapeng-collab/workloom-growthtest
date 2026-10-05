import { describe, expect, it } from "vitest";
import { assertDemoLoginAllowed, desktopLoginTarget } from "./desktop-auth.js";

const key = "c".repeat(64);
const env = { NODE_ENV: "production", SERVER_HOST: "127.0.0.1", WORKLOOM_DESKTOP_LOGIN_KEY: key,
  WORKLOOM_DESKTOP_WORKSPACE: "local-test", WORKLOOM_DESKTOP_MEMBER: "MEM-T01" };
describe("production identity boundaries", () => {
  it("public impersonation fails even with a desktop configured", () => {
    expect(() => assertDemoLoginAllowed(env)).toThrow("账户登录");
    expect(() => assertDemoLoginAllowed({ NODE_ENV: "development" })).not.toThrow();
  });
  it.each(["", "0".repeat(64), "c".repeat(63), "é".repeat(64)])("invalid capability %s fails closed", (supplied) => {
    expect(() => desktopLoginTarget(new Headers({ "x-workloom-desktop-key": supplied }), env)).toThrow("登录凭证");
  });
  it("capability is limited to the configured local target", () => {
    expect(desktopLoginTarget(new Headers({ "x-workloom-desktop-key": key }), env))
      .toEqual({ workspaceSlug: "local-test", memberNo: "MEM-T01" });
    expect(() => desktopLoginTarget(new Headers({ "x-workloom-desktop-key": key }), { ...env, SERVER_HOST: "0.0.0.0" })).toThrow();
    expect(() => desktopLoginTarget(new Headers({ "x-workloom-desktop-key": key }), { ...env, WORKLOOM_DESKTOP_LOGIN_KEY: "" })).toThrow();
  });
});
