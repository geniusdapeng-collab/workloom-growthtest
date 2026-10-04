// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MateLive2D } from "./MateLive2D";

const fake = vi.hoisted(() => {
  let finishImport!: () => void;
  const importReady = new Promise<void>((resolve) => { finishImport = resolve; });
  return { importReady, finishImport, apps: [] as Array<{
    view: HTMLCanvasElement; render: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
    children: Array<{ destroy: () => void }>;
  }>, from: vi.fn(), releaseContext: vi.fn() };
});

vi.mock("pixi.js", () => ({
  Application: class {
    view = document.createElement("canvas");
    children: Array<{ destroy: () => void }> = [];
    stage = { addChild: (model: { destroy: () => void }) => this.children.push(model) };
    render = vi.fn();
    destroy = vi.fn(() => { this.children.forEach(model => model.destroy()); this.view.remove(); });
    constructor() { fake.apps.push(this); }
  },
}));
vi.mock("pixi-live2d-display", async () => {
  await fake.importReady;
  return { Live2DModel: { from: fake.from } };
});
vi.mock("../../voice/VoiceEngine", () => ({ VoiceEngine: { onLipSync: () => () => undefined } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function model(expression = Promise.resolve(true)) {
  return {
    width: 100, height: 200, x: 0, y: 0,
    scale: { set: vi.fn() }, anchor: { set: vi.fn() },
    expression: vi.fn(() => expression), motion: vi.fn(async () => true),
    update: vi.fn(), focus: vi.fn(), destroy: vi.fn(),
    internalModel: {
      coreModel: {
        getModel: () => ({ parameters: { ids: ["ParamA", "ParamMouthForm", "ParamEyeLOpen", "ParamEyeROpen"] } }),
        setParameterValueByIndex: vi.fn(),
      },
      on: vi.fn(), off: vi.fn(),
    },
  };
}

async function flush() {
  await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
}

describe("数字人异步加载的组件归属", () => {
  let host: HTMLDivElement;
  let root: Root | null;
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fake.apps.length = 0;
    fake.from.mockReset();
    fake.releaseContext.mockClear();
    window.Live2D = {};
    delete (window as unknown as { __loommateL2DErr?: string }).__loommateL2DErr;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      getExtension: () => ({ loseContext: fake.releaseContext }),
    }) as unknown as WebGLRenderingContext);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => { root?.unmount(); root = null; });
    host.remove();
    vi.restoreAllMocks();
  });

  it("插件 import 期间退出，不创建已失去容器的 Pixi 实例", async () => {
    await act(async () => { root!.render(<MateLive2D size={320} />); });
    await act(async () => { root!.unmount(); root = null; });
    fake.finishImport();
    await flush();
    expect(fake.apps).toHaveLength(0);
    expect(fake.from).not.toHaveBeenCalled();
    expect((window as unknown as { __loommateL2DErr?: string }).__loommateL2DErr).toBeUndefined();
  });

  it("模型到达前退出，销毁迟到模型且不回写 ready", async () => {
    const pending = deferred<ReturnType<typeof model>>();
    fake.from.mockReturnValue(pending.promise);
    const onReady = vi.fn();
    await act(async () => { root!.render(<MateLive2D size={320} onReady={onReady} />); });
    await flush();
    expect(fake.apps).toHaveLength(1);
    await act(async () => { root!.unmount(); root = null; });
    const late = model();
    pending.resolve(late);
    await flush();
    expect(late.destroy).toHaveBeenCalledOnce();
    expect(fake.apps[0]!.destroy).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    expect(window.__loommateLive2DReady).toBeUndefined();
  });

  it("表情加载期间退出，不安装旧组件的动作和时钟", async () => {
    const expression = deferred<boolean>();
    const character = model(expression.promise);
    fake.from.mockResolvedValue(character);
    const onReady = vi.fn();
    await act(async () => { root!.render(<MateLive2D size={320} mood="happy" onReady={onReady} />); });
    await flush();
    expect(character.expression).toHaveBeenCalled();
    await act(async () => { root!.unmount(); root = null; });
    expression.resolve(true);
    await flush();
    expect(onReady).not.toHaveBeenCalled();
    expect(window.__loommateLive2DReady).toBeUndefined();
    expect(window.__loommateExercise).toBeUndefined();
    expect(fake.apps[0]!.render).not.toHaveBeenCalled();
  });

  it("保持挂载时仍完成模型、手势与实际首次渲染", async () => {
    const character = model();
    fake.from.mockResolvedValue(character);
    const onReady = vi.fn();
    await act(async () => { root!.render(<MateLive2D size={320} mood="happy" gesture="handup" onReady={onReady} />); });
    await flush();
    expect(onReady).toHaveBeenCalledOnce();
    expect(character.motion).toHaveBeenCalledWith("TapBody");
    expect(fake.apps[0]!.render).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-avatar-ready="true"]')).not.toBeNull();
    expect(host.querySelector('[data-render-mode="live2d-webgl"]')).not.toBeNull();
  });
});
