"use strict";

/** A capability probe must release its temporary GPU context. */
function probeWebGL(document) {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!context) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Follow the real guide lifecycle within the existing render smoke deadline. */
async function dismissFirstDayGuide(probe, {
  timeoutMs = 10000,
  now = Date.now,
  pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = now() + timeoutMs;
  let shown = false;
  let clicked = false;
  let supported = false;
  let clearSince = null;
  const expired = Symbol("guide-deadline");
  while (now() < deadline) {
    let timeout;
    let state;
    try {
      state = await Promise.race([
        Promise.resolve().then(probe),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(expired), Math.max(0, deadline - now())); }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (state === expired || now() >= deadline) break;
    if (!state || [state.shown, state.clicked, state.supported].some((value) => typeof value !== "boolean")) {
      throw new Error("首日上岗引导探针返回非法状态");
    }
    supported ||= state.supported;
    shown ||= state.shown;
    clicked ||= state.clicked;
    if (state.shown) {
      if (!state.clicked) throw new Error("首日上岗引导缺少可用退出按钮");
      clearSince = null;
    } else if (!supported || shown) {
      clearSince ??= now();
      // 等 React 的后续提交稳定，不能以 welcome/guide 两层之间的空帧判定退出。
      if (now() - clearSince >= 750) return { shown, clicked, supported, closed: true };
    }
    await pause(Math.min(250, Math.max(0, deadline - now())));
  }
  return { shown, clicked, supported, closed: false };
}

module.exports = { dismissFirstDayGuide, probeWebGL };
