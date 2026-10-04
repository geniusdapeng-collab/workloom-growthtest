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
  const sceneProbes = [];
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
  const sceneQueries = new Map();
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
          const sceneName = code.includes("report-stage") ? "stage" : "workplace";
          const count = (sceneQueries.get(sceneName) || 0) + 1;
          sceneQueries.set(sceneName, count);
          const actors = sceneName === "stage" ? 15 : 14;
          const canvas = {
            getBoundingClientRect: () => canvasRect,
            width: options.canvasResizes ? (count === 1 ? 300 : 1536) : 768,
            height: options.canvasResizes ? (count === 1 ? 150 : 880) : canvasRect.height,
          };
          const scene = {
            getBoundingClientRect: () => rect,
            getAttribute: (name) => name.includes("actors") ? String(actors) : null,
            matches: () => false,
            querySelector: () => canvas,
            style: {}, parentElement: null,
            offsetWidth: rect.width, offsetHeight: rect.height,
            contains: (node) => {
              for (let current = node; current; current = current.parentElement) if (current === scene) return true;
              return false;
            },
          };
          const element = (definition, parent) => {
            const box = { x: rect.x + 20, y: rect.y + 40, width: 100, height: 28, ...definition.rect };
            return {
              textContent: definition.text || "公司负责人",
              style: definition.style || {}, parentElement: parent,
              offsetWidth: definition.offsetWidth ?? box.width, offsetHeight: definition.offsetHeight ?? box.height,
              getBoundingClientRect: () => box,
              getAttribute: (name) => definition.attributes?.[name] ?? null,
            };
          };
          const definitions = options.nameplates?.(sceneName, count) || [];
          const nameplates = definitions.map((definition) => {
            let parent = scene;
            for (const ancestor of definition.ancestors || []) parent = element(ancestor, parent);
            return element(definition, parent);
          });
          scene.querySelectorAll = () => nameplates;
          const style = (node) => ({
            display: "block", position: "static", opacity: "1", clipPath: "none", clip: "auto", contentVisibility: "visible",
            overflow: "visible", overflowX: "visible", overflowY: "visible",
            visibility: node?.style?.visibility || (node?.parentElement ? style(node.parentElement).visibility : "visible"),
            ...node?.style,
          });
          const overlay = { getBoundingClientRect: () => rect, getAttribute: () => "首日上岗引导", style: {}, parentElement: null };
          // Execute the real DOM probe so late layout/bitmap changes are measured by production code.
          const probe = vm.runInNewContext(code, {
            document: {
              querySelector: () => options.vanishedScene && count > 1 ? null : scene,
              querySelectorAll: () => options.covered ? [overlay] : [],
              elementFromPoint: () => options.covered ? overlay : scene,
            },
            getComputedStyle: style,
            innerWidth: 1440, innerHeight: 872,
          });
          sceneProbes.push({ sceneName, count, probe: JSON.parse(JSON.stringify(probe)) });
          return probe;
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
  try {
    await vm.runInContext("win = __fixtureWindow; supportDirResolved = '/fixture'; runRenderSmoke()", context);
  } catch (error) {
    error.fixture = { images, writes, sceneProbes };
    throw error;
  }
  return { images, writes, sceneProbes };
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

test("native smoke records the settled canvas bitmap instead of its initial 300x150 bitmap", async () => {
  const result = await runFixture({ canvasResizes: true });
  const reports = [...result.writes.entries()]
    .filter(([file]) => /(?:workplace|stage)-default\.json$/.test(file))
    .map(([, bytes]) => JSON.parse(bytes));
  assert.equal(reports.length, 2);
  for (const report of reports) assert.deepEqual(report.canvas, { width: 1536, height: 880 });
});

test("native smoke rejects a product scene removed before the camera-settled capture", async () => {
  await assert.rejects(runFixture({ vanishedScene: true }), /未就绪|不存在/i);
});

const visiblePlates = (count) => Array.from({ length: count }, (_, index) => ({
  text: `岗位${index + 1}`,
  rect: { x: 240 + index * 130, y: 180, width: 100, height: 28 },
}));
const workplacePlates = (definitions) => (sceneName) => sceneName === "workplace" ? definitions : [];
const reportsOf = (fixture) => [...fixture.writes.entries()]
  .filter(([file]) => /(?:workplace|stage)-default\.json$/.test(file))
  .map(([, bytes]) => JSON.parse(bytes));

test("native smoke keeps 19 keyboard entries but counts only the one actually visible plate", async () => {
  const definitions = [visiblePlates(1)[0], ...Array.from({ length: 18 }, (_, index) => ({
    text: `待命岗位${index + 1}`,
    rect: { x: 240 + index * 20, y: 240, width: 184, height: 1 },
    style: { opacity: "0", clipPath: "inset(50%)" },
    attributes: { "data-worker-card-visible": "true" },
  }))];
  const fixture = await runFixture({ nameplates: workplacePlates(definitions) });
  const report = reportsOf(fixture)[0];
  assert.equal(report.allLabels.length, 19);
  assert.deepEqual(report.labels, ["岗位1"]);
  assert.equal(report.hiddenLabels.length, 18);
  assert.deepEqual(report.labelCounts, { all: 19, visible: 1, hidden: 18 });
  assert.equal(report.nameplates.filter((plate) => !plate.visible && plate.reasons.includes("opacity-zero")).length, 18);
  assert.equal(fixture.sceneProbes.length, 4, "both actual initial and settled probes execute for both scenes");
  for (const sample of fixture.sceneProbes.filter((sample) => sample.sceneName === "workplace")) {
    assert.deepEqual(sample.probe.labelCounts, { all: 19, visible: 1, hidden: 18 });
  }
});

for (const [name, definition, reason] of [
  ["an opacity-zero ancestor", { ancestors: [{ style: { opacity: "0" } }] }, "opacity-zero"],
  ["a display-none ancestor", { ancestors: [{ style: { display: "none" } }] }, "display-none"],
  ["inherited visibility-hidden", { ancestors: [{ style: { visibility: "hidden" } }] }, "visibility-hidden"],
  ["an ancestor whose content is skipped", { ancestors: [{ style: { contentVisibility: "hidden" } }] }, "content-visibility-hidden"],
  ["an empty inset clip without an opacity hint", { style: { clipPath: "inset(50%)" } }, "clip-path-empty"],
  ["an empty legacy rectangular clip", { style: { position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" } }, "clip-empty"],
  ["an overflow-clipped ancestor", { rect: { y: 300 }, ancestors: [{ rect: { y: 180, height: 20 }, style: { overflowY: "hidden" } }] }, "overflow-empty"],
  ["a rectangle outside the viewport", { rect: { x: 1500 } }, "outside-viewport"],
  ["a rectangle outside the scene", { rect: { x: 40 } }, "outside-scene"],
  ["a zero-height rectangle", { rect: { height: 0 } }, "zero-size"],
]) {
  test(`native smoke excludes ${name} and records its concrete reason`, async () => {
    const definitions = [visiblePlates(1)[0], { text: "不可见键盘入口", ...definition }];
    const fixture = await runFixture({ nameplates: workplacePlates(definitions) });
    const report = reportsOf(fixture)[0];
    assert.deepEqual(report.labels, ["岗位1"]);
    assert.deepEqual(report.hiddenLabels, ["不可见键盘入口"]);
    assert.ok(report.nameplates[1].reasons.includes(reason), JSON.stringify(report.nameplates[1]));
  });
}

test("native smoke records the effective rectangle after ancestor inset and viewport clipping", async () => {
  const fixture = await runFixture({ nameplates: workplacePlates([{
    text: "部分裁剪岗位", rect: { x: 240, y: 180, width: 100, height: 28 },
    ancestors: [{ rect: { x: 250, y: 175, width: 100, height: 40 }, style: { clipPath: "inset(0 25% 0 0)" } }],
  }]) });
  const report = reportsOf(fixture)[0];
  assert.deepEqual(report.labels, ["部分裁剪岗位"]);
  assert.deepEqual(report.nameplates[0].effectiveRect, { x: 250, y: 180, width: 75, height: 28 });
});

test("native smoke preserves visibility explicitly restored below a hidden ancestor", async () => {
  const definitions = visiblePlates(5).map((plate) => ({
    ...plate, style: { visibility: "visible" }, ancestors: [{ style: { visibility: "hidden" } }],
  }));
  await assert.rejects(runFixture({ nameplates: workplacePlates(definitions) }), (error) => {
    assert.match(error.message, /空闲态名牌过密/);
    assert.equal(reportsOf(error.fixture)[0].labels.length, 5);
    return true;
  });
});

test("native smoke still rejects five visible plates despite a lying worker visibility attribute", async () => {
  const definitions = visiblePlates(5).map((plate) => ({ ...plate, attributes: { "data-worker-card-visible": "false" } }));
  await assert.rejects(runFixture({ nameplates: workplacePlates(definitions) }), (error) => {
    assert.match(error.message, /空闲态名牌过密/);
    assert.deepEqual(reportsOf(error.fixture)[0].labelCounts, { all: 5, visible: 5, hidden: 0 });
    return true;
  });
});

test("native smoke does not discard overlapping visible plates based on elementFromPoint", async () => {
  const definitions = visiblePlates(5).map((plate) => ({ ...plate, rect: { x: 240, y: 180, width: 100, height: 28 } }));
  await assert.rejects(runFixture({ nameplates: workplacePlates(definitions) }), (error) => {
    assert.match(error.message, /空闲态名牌过密/);
    const report = reportsOf(error.fixture)[0];
    assert.deepEqual(report.labelCounts, { all: 5, visible: 5, hidden: 0 });
    assert.equal(report.nameplateOverlaps.length, 10);
    return true;
  });
});

test("native smoke rejects two overlapping visible plates even below the density limit", async () => {
  const definitions = visiblePlates(2).map((plate) => ({ ...plate, rect: { x: 240, y: 180, width: 100, height: 28 } }));
  await assert.rejects(runFixture({ nameplates: workplacePlates(definitions) }), (error) => {
    assert.match(error.message, /名牌重叠/);
    assert.equal(reportsOf(error.fixture)[0].labels.length, 2);
    return true;
  });
});

test("native smoke recalculates hidden-to-visible plates after the camera settles", async () => {
  await assert.rejects(runFixture({
    nameplates: (sceneName, count) => sceneName !== "workplace" ? [] : visiblePlates(5).map((plate) => ({
      ...plate, style: { opacity: count === 1 ? "0" : "1" },
    })),
  }), (error) => {
    assert.match(error.message, /空闲态名牌过密/);
    const samples = error.fixture.sceneProbes.filter((sample) => sample.sceneName === "workplace");
    assert.equal(samples[0].probe.labels.length, 0);
    assert.equal(samples[1].probe.labels.length, 5);
    assert.equal(reportsOf(error.fixture)[0].labels.length, 5);
    return true;
  });
});

test("native smoke recalculates visible-to-hidden plates and accepts exactly four separated visible plates", async () => {
  const fixture = await runFixture({ nameplates: (sceneName, count) => sceneName !== "workplace" ? [] : [
    ...visiblePlates(4), { text: "稍后隐藏", rect: { x: 240, y: 300, width: 100, height: 28 }, style: { opacity: count === 1 ? "1" : "0" } },
  ] });
  const samples = fixture.sceneProbes.filter((sample) => sample.sceneName === "workplace");
  assert.equal(samples[0].probe.labels.length, 5);
  assert.equal(samples[1].probe.labels.length, 4);
  assert.deepEqual(reportsOf(fixture)[0].labelCounts, { all: 5, visible: 4, hidden: 1 });
});

test("native smoke conservatively counts an unsupported clip rather than hiding a potentially visible plate", async () => {
  const definitions = visiblePlates(5).map((plate) => ({ ...plate, style: { clipPath: "polygon(0 0, 100% 0, 100% 100%)" } }));
  await assert.rejects(runFixture({ nameplates: workplacePlates(definitions) }), (error) => {
    assert.match(error.message, /空闲态名牌过密/);
    const report = reportsOf(error.fixture)[0];
    assert.equal(report.labels.length, 5);
    assert.ok(report.nameplates.every((plate) => plate.unresolvedClips.length === 1));
    return true;
  });
});

test("native smoke rejects invalid nameplate geometry instead of removing it from the verdict", async () => {
  await assert.rejects(runFixture({ nameplates: workplacePlates([{ text: "无效矩形", rect: { x: NaN } }]) }), /名牌几何无效/);
});

test("native smoke ignores legacy clip on static positioning and still rejects its five visible plates", async () => {
  const definitions = visiblePlates(5).map((plate) => ({ ...plate, style: { position: "static", clip: "rect(0px, 0px, 0px, 0px)" } }));
  await assert.rejects(runFixture({ nameplates: workplacePlates(definitions) }), (error) => {
    assert.match(error.message, /空闲态名牌过密/);
    assert.deepEqual(reportsOf(error.fixture)[0].labelCounts, { all: 5, visible: 5, hidden: 0 });
    return true;
  });
});
