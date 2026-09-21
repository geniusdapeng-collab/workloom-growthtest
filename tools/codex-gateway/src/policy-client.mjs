/**
 * 策略桥客户端：懒启动 tsx 子进程，JSON-lines 请求/响应，失败 fail-closed。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gatewayFile, resolveRepoRoot } from "./paths.mjs";

export class PolicyUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyUnavailableError";
  }
}

export function createPolicyClient({ repoRoot = resolveRepoRoot(), timeoutMs = 20000 } = {}) {
  let child = null;
  let nextId = 1;
  const pending = new Map();
  let ready = false;

  function start() {
    if (child) return;
    const tsxDir = join(repoRoot, "node_modules", "tsx", "dist");
    const preflight = join(tsxDir, "preflight.cjs");
    const loader = join(tsxDir, "loader.mjs");
    if (!existsSync(preflight) || !existsSync(loader)) {
      throw new PolicyUnavailableError(`未找到 tsx（${tsxDir}）。请先 pnpm install，或使用模拟策略。`);
    }
    const bridge = gatewayFile("bridge", "policy-bridge.mts");
    // 直接以 tsx 的 loader 启动桥进程（不再经过 tsx CLI 包装进程），
    // 否则 kill 只杀包装进程，孙进程会持有 stdout 导致调用方无法退出。
    child = spawn(process.execPath, ["--require", preflight, "--import", pathToFileURL(loader).href, bridge], {
      cwd: repoRoot,
      env: { ...process.env, WORKLOOM_REPO_ROOT: repoRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) process.stderr.write(`[policy-bridge] ${text}\n`);
    });
    child.once("exit", (code) => {
      ready = false;
      const error = new PolicyUnavailableError(`策略桥退出（code=${code ?? "null"}），写操作 fail-closed`);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      child = null;
    });
    ready = true;
  }

  function call(method, params, timeout = timeoutMs) {
    start();
    if (!child) throw new PolicyUnavailableError("策略桥不可用");
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PolicyUnavailableError(`策略桥调用超时：${method}`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return {
    get ready() {
      return ready;
    },
    judge: (input) => call("judge", { input }),
    validateGesture: (gesture, role = "owner") => call("gesture", { gesture, role }),
    validateEvent: (event) => call("validateEvent", { event }),
    packs: () => call("packs", {}),
    ping: () => call("ping", {}),
    close: () => {
      if (child) {
        const victim = child;
        victim.kill("SIGTERM");
        setTimeout(() => {
          if (!victim.killed) victim.kill("SIGKILL");
        }, 1000).unref?.();
      }
      child = null;
    },
  };
}

/** 测试/离线用：固定裁决的模拟策略（仅测试，不得用于生产路径）。 */
export function createFakePolicy(verdicts = {}) {
  return {
    async judge(input) {
      const key = `${input.object?.type}:${input.action}`;
      return verdicts[key] ?? { level: "review", impacts: [], triggeredBy: ["fake-policy-default"], evalErrors: [] };
    },
    async validateGesture(gesture) {
      if (gesture.type === "reject" && !gesture.reasonEnum) throw new Error("EMPTY_REASON");
      if (gesture.type === "edit" && gesture.editedAfter === undefined) throw new Error("EDIT_REQUIRES_AFTER");
      if (!["approve", "edit", "reject"].includes(gesture.type)) throw new Error("INVALID_GESTURE");
      return { ok: true };
    },
    async packs() {
      return { defaultLevel: "review", packs: [], activeRules: 0 };
    },
    async ping() {
      return { ok: true };
    },
    close() {},
  };
}
