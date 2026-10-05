// @vitest-environment jsdom
// Regression derived from the independent OBS13 ready-edge counterexample.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useQuestline, type QuestlineApi } from "./useQuestline";
import { createQuestState, EMPTY_FACTS, QUEST_STORAGE_KEY } from "./questline";
import { QUESTLINE_GEO } from "./questline.config";

let root: Root;
let container: HTMLDivElement;
let api: QuestlineApi;
function Harness({ ready }: { ready: boolean }) {
  api = useQuestline({ ready, facts: EMPTY_FACTS, content: QUESTLINE_GEO });
  return api.open ? <button data-test-guide="true" onClick={api.closeQuestline}>稍后再来</button> : null;
}
async function render(ready: boolean) {
  await act(async () => { root.render(<Harness ready={ready} />); });
}
async function close() {
  await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
});
describe("首日引导关闭与 ready 边沿", () => {
  it("初次ready真正打开；点击稍后再来后相同ready重渲染保持关闭", async () => {
    await render(true);
    expect(api.open).toBe(true);
    expect(container.querySelector("button")).not.toBeNull();
    await close();
    await render(true);
    expect(api.open).toBe(false);
    expect(container.querySelector("button")).toBeNull();
    expect(api.events().filter(event => event.name === "questline.closed")).toHaveLength(1);
  });
  it("同一会话关闭后ready短暂false再true不能抢回引导", async () => {
    await render(true);
    await close();
    expect(api.open).toBe(false);
    await render(false);
    expect(api.open).toBe(false);
    await render(true);
    expect(api.open).toBe(false);
    expect(container.querySelector("button")).toBeNull();
  });
  it("关闭后客户手动打开仍可继续原有进度", async () => {
    await render(true);
    await close();
    const state = api.state;
    await act(async () => api.openQuestline());
    expect(api.open).toBe(true);
    expect(api.state.startedAt).toBe(state.startedAt);
    expect(api.state.stage).toBe(state.stage);
    expect(api.events().filter(event => event.name === "questline.opened")).toHaveLength(1);
  });
  it("已完成旅程不自动打开；客户仍能手动查看完成面板", async () => {
    localStorage.setItem(QUEST_STORAGE_KEY, JSON.stringify({ ...createQuestState(1), status: "completed", completedAt: 2 }));
    await render(true);
    expect(api.open).toBe(false);
    await act(async () => api.openQuestline());
    expect(api.open).toBe(true);
    expect(api.state.status).toBe("completed");
  });
});
