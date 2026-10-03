const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// This tests the application's actual smoke implementation against a controlled renderer.
// Native screenshot/geometry evidence is collected separately from the packaged application.
async function runFixture(options = {}) {
  const images = [];
  const writes = new Map();
  const image = (blank) => ({
    isEmpty: () => false,
    getSize: () => ({ width: 64, height: 64 }),
    toPNG: () => Buffer.from("renderer-test-image"),
    toBitmap: () => {
      const pixels = Buffer.alloc(64 * 64 * 4, 255);
      for (let i = 0; i < 64 * 64; i++) {
        const value = blank ? 0 : i % 2 ? 30 : 170;
        pixels[i * 4] = value; pixels[i * 4 + 1] = value; pixels[i * 4 + 2] = value;
      }
      return pixels;
    },
  });
  let transition = 0;
  const rect = { x: 220, y: 140, width: 768, height: 440 };
  const canvasRect = { ...rect, height: options.shortCanvas ? 150 : 440 };
  const telemetry = { backend: "live2d-webgl", mouthPeak: 0.5, lipStarts: 1, blinkCount: 1, gestureCount: 1, parameterWrites: 3, parameterWriteFailures: 0 };
  const scene = {
    ready: true, actors: 14, totalActors: 14, labels: [], rect, canvasRect,
    canvas: { rect: canvasRect, width: 768, height: canvasRect.height, contextLost: false, frames: 20 },
    visibleRatio: options.covered ? 0 : 1, visibleSamples: options.covered ? 0 : 25,
    sampleCount: 25, obstructedSamples: options.covered ? 25 : 0,
    overlays: options.covered ? ["首日上岗引导"] : [],
    viewport: { width: 1440, height: 872 }, pageErrors: [],
  };
  const nativeWindow = {
    isDestroyed: () => false, isVisible: () => true, show: () => {}, focus: () => {},
    webContents: {
      setBackgroundThrottling: () => {},
      capturePage: async (crop) => {
        images.push(crop ?? null);
        return image(Boolean(crop && options.blankScene));
      },
      executeJavaScript: async (code) => {
        if (code.includes("__loommateExercise")) return true;
        if (code.includes("__loommateTelemetry")) return telemetry;
        if (code.includes("data-welcome-segment")) {
          const stages = [
            { phase: "mate", segment: "intro", exiting: "false" },
            { phase: "mate", segment: "bridge", exiting: "false" },
            { phase: "mate", segment: "bridge", exiting: "true" },
            { phase: "entrance", segment: null, exiting: null },
          ];
          return stages[Math.min(transition++, stages.length - 1)];
        }
        if (code.includes("data-ceremony-ready")) return { ready: true, mode: "vector2d", actors: 15 };
        if (code.includes("data-product-scene=")) {
          return { ...scene, actors: code.includes("report-stage") ? 15 : 14, totalActors: code.includes("report-stage") ? 15 : 14 };
        }
        if (code.includes("data-product-ready")) return { productReady: true, avatarReady: true, actorCount: 14, bundle: "ai-pm", renderMode: "live2d-webgl", ceremonyMode: "vector2d", webgl: true };
        if (code.includes("data-questline-overlay")) return { open: false, dismissed: false };
        if (code.includes("overlay:")) return { overlay: false };
        if (code.includes("requestAnimationFrame")) return true;
        return true;
      },
    },
  };
  const app = { setPath: () => {}, getPath: () => "/fixture", getName: () => "renderer-fixture", getVersion: () => "fixture", requestSingleInstanceLock: () => false, quit: () => {}, on: () => {}, whenReady: () => new Promise(() => {}) };
  const context = vm.createContext({
    Buffer, URL, setTimeout: (callback) => { callback(); return 0; }, clearTimeout: () => {},
    console: { log: () => {}, error: () => {} },
    process: { env: { WORKLOOM_PORT_OFFSET: "0", WORKLOOM_SUPPORT_DIR: "/fixture" }, argv: [], platform: "darwin", arch: "arm64" },
    __dirname, __filename: path.join(__dirname, "main.cjs"), __fixtureWindow: nativeWindow,
    require: (name) => {
      if (name === "electron") return { app };
      if (name === "./bootstrap.cjs") return {};
      if (name === "node:fs") return { mkdirSync: () => {}, writeFileSync: (file, data) => writes.set(file, data) };
      if (name.startsWith("./")) return require(path.join(__dirname, name));
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8"), context);
  await vm.runInContext("win = __fixtureWindow; supportDirResolved = '/fixture'; runRenderSmoke()", context);
  return { images, writes };
}

test("native smoke accepts a visible, full-height, nonblank product scene", async () => {
  const result = await runFixture();
  assert.ok(result.writes.size > 0);
});

test("native smoke rejects a canvas that renders only the top 150px of a 440px scene", async () => {
  await assert.rejects(runFixture({ shortCanvas: true }), /画布|canvas|尺寸/i);
});

test("native smoke rejects a product scene hidden behind an onboarding overlay", async () => {
  await assert.rejects(runFixture({ covered: true }), /遮挡|覆盖|可见|引导/i);
});

test("native smoke rejects black scene pixels even when the navigation has healthy pixels", async () => {
  await assert.rejects(runFixture({ blankScene: true }), /纯黑|纯色|像素/i);
});

test("native smoke captures the actual product region for its pixel verdict", async () => {
  const result = await runFixture();
  assert.ok(result.images.filter(Boolean).length >= 2, "both workplace and reporting stage must be captured independently");
});
