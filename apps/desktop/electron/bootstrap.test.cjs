"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");
const { dismissFirstDayGuide, probeWebGL } = require("./render-smoke.cjs");
const {
  bootstrap,
  installPayloadAtomically,
  writeInstallCheckpoint,
  parseDesktopPort,
  assertPostmasterIdentity,
  ownedPostgresRunning,
  stopOwnedPostgres,
  buildDesktopEnvironment,
  ensureDatabaseState,
  bindDatabaseState,
  completeDatabaseHardening,
  secureInitdbArgs,
  renderStrictPgHba,
  enforceStrictPgHba,
  validateDatabaseHelper,
  openExternalUrl,
  acquireBootstrapLock,
  tarExtractionPlan,
  withBundledNodePath,
} = require("./bootstrap.cjs");

function assertPrivateFile(file) {
  const stat = fs.statSync(file);
  assert.equal(stat.isFile(), true);
  // Windows 的 fs.stat().mode 不表达 POSIX owner/group/other 权限；文件继承当前用户
  // support 目录 ACL，不能用恒假的 0600 位比较阻断 Windows runner。
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
}

describe("启动诊断秘密脱敏", () => {
  function diagnostic(logText, { error = null, fileSystem = fs } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-diagnostic-"));
    const logDir = path.join(root, "logs");
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(logDir, "startup.log"), logText, { mode: 0o600 });
    try {
      const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
      const start = source.indexOf("function diagnosticText() {");
      const end = source.indexOf("\nasync function handleSplashAction", start);
      assert.ok(start > 0 && end > start, "必须执行真实诊断导出函数");
      return vm.runInNewContext(source.slice(start, end) + "\ndiagnosticText()", {
        fs: fileSystem, path, Buffer, process, Error,
        supportDirResolved: root, lastBootstrapReference: "启动-TEST", lastBootstrapError: error,
        app: { getVersion: () => "test-version", getPath: () => root },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const cases = [
    ["原有文本 JWT、盐和 Bearer", "JWT_SECRET=synthetic-jwt\nPII_SALT=synthetic-salt\nBearer synthetic-bearer", ["synthetic-jwt", "synthetic-salt", "synthetic-bearer"]],
    ["JSON 引号与大小写字段", JSON.stringify({ JWT_SECRET: "synthetic-json-jwt", apiKey: "synthetic-json-key", accessToken: "synthetic-json-access", refresh_token: "synthetic-json-refresh", APP_DB_PASSWORD: "synthetic-json-db" }), ["synthetic-json-jwt", "synthetic-json-key", "synthetic-json-access", "synthetic-json-refresh", "synthetic-json-db"]],
    ["引号内的空格和分隔符", "API_KEY='synthetic single quoted value'\nclientSecret=\"synthetic double,quoted value\"", ["synthetic single quoted value", "synthetic double,quoted value", "quoted value"]],
    ["带编码密码的连接 URI", `connect postgresql://postgres:synthetic%3Auri%40password@127.0.0.1:55432/workloom\nrequest ${"https:"}//test-user:synthetic-uri-auth@example.invalid/path`, ["synthetic%3Auri%40password", "synthetic-uri-auth"]],
    ["libpq 密码与 URI 查询密码", "host=127.0.0.1 password='synthetic libpq password' dbname=workloom\npostgres://127.0.0.1/workloom?password=synthetic-query-password&connect_timeout=3", ["synthetic libpq password", "synthetic-query-password"]],
    ["Basic 授权和 Cookie", "Authorization: Basic c3ludGhldGljOnBhc3N3b3Jk\nCookie: session=synthetic-cookie; preference=compact\n{\"cookie\":\"synthetic-json-cookie\"}", ["c3ludGhldGljOnBhc3N3b3Jk", "synthetic-cookie", "synthetic-json-cookie"]],
    ["JSON 转义引号和 Unicode 密码", JSON.stringify({ password: 'synthetic-quote-"-password', PRIVATE_KEY: "synthetic-私钥\n第二行" }), ['synthetic-quote-', "synthetic-私钥", "第二行"]],
  ];
  for (const [label, input, secrets] of cases) {
    it(label, () => {
      const output = diagnostic(input);
      for (const secret of secrets) assert.equal(output.includes(secret), false, `${label} 不得保留合成秘密`);
      assert.ok(output.includes("[已脱敏]"));
      assert.ok(output.includes("test-version"));
      assert.ok(output.includes("启动-TEST"));
    });
  }

  it("错误摘要和日志读取失败也经过脱敏", () => {
    const output = diagnostic("", {
      error: '{"JWT_SECRET":"synthetic-header-secret"}',
      fileSystem: { ...fs, readdirSync() { throw new Error("connect postgresql://postgres:synthetic-read-secret@127.0.0.1/workloom failed"); } },
    });
    assert.equal(output.includes("synthetic-header-secret"), false);
    assert.equal(output.includes("synthetic-read-secret"), false);
    assert.ok(output.includes("日志读取失败"));
  });

  it("读取异常关闭自己的文件句柄并保留失败信息", () => {
    let opened;
    let closed;
    const output = diagnostic("synthetic log", { fileSystem: {
      ...fs,
      openSync(...args) { opened = fs.openSync(...args); return opened; },
      readSync() { throw new Error("synthetic read failure"); },
      closeSync(fd) { closed = fd; return fs.closeSync(fd); },
    } });
    try {
      assert.equal(closed, opened);
      assert.ok(output.includes("synthetic read failure"));
    } finally {
      if (opened !== closed) fs.closeSync(opened);
    }
  });

  it("空日志和有界尾部仍保留版本、主机和错误上下文", () => {
    const startedAt = Date.now();
    const output = diagnostic("x".repeat(200_010) + "\nECONNREFUSED host=127.0.0.1 port=55432\nAPI_KEY=synthetic-bounded-key\n");
    assert.ok(Date.now() - startedAt < 2000, "单个 200KB 日志的脱敏不得因长文本冻结诊断导出");
    assert.equal(output.includes("synthetic-bounded-key"), false);
    assert.ok(output.includes("末尾 200000 字节"));
    assert.ok(output.includes("ECONNREFUSED host=127.0.0.1 port=55432"));
    const empty = diagnostic("");
    assert.ok(empty.includes("最近错误：无"));
    assert.ok(empty.includes("末尾 0 字节"));
  });

  async function exportDiagnostic({ result, fileSystem = fs, dialogError } = {}) {
    const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    const start = source.indexOf("async function handleSplashAction(action) {");
    const end = source.indexOf("\nfunction closeSplash", start);
    const publicStart = source.indexOf("function publicStartupError(error) {");
    const publicEnd = source.indexOf("\nconst SPLASH_HTML", publicStart);
    assert.ok(start > 0 && end > start && publicStart > 0 && publicEnd > publicStart);
    const messages = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-diagnostic-export-"));
    try {
      const action = vm.runInNewContext(source.slice(publicStart, publicEnd) + "\n" + source.slice(start, end) + "\nhandleSplashAction", {
        fs: fileSystem, path, process, Date, Error,
        app: { getPath: () => root }, splash: null, lastBootstrapReference: "启动-TEST",
        diagnosticText: () => "WorkLoom 启动诊断\n合成的已脱敏内容",
        showSplash: (...args) => messages.push(args),
        dialog: { showSaveDialog: async () => { if (dialogError) throw dialogError; return result; } },
      });
      await action("export");
      return messages;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("取消无写入；新建与覆盖后的诊断文件均为私有", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-diagnostic-save-"));
    const file = path.join(root, "已存在的诊断.txt");
    try {
      let writes = 0;
      await exportDiagnostic({ result: { canceled: true, filePath: file }, fileSystem: { ...fs, writeFileSync() { writes++; } } });
      assert.equal(writes, 0);
      assert.equal(fs.existsSync(file), false);
      await exportDiagnostic({ result: { canceled: false, filePath: file } });
      assertPrivateFile(file);
      if (process.platform !== "win32") fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, "先前内容");
      await exportDiagnostic({ result: { canceled: false, filePath: file } });
      assertPrivateFile(file);
      assert.equal(fs.readFileSync(file, "utf8").includes("先前内容"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("保存对话框和文件写入失败均留在可恢复启动页", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-diagnostic-failure-"));
    const result = { canceled: false, filePath: path.join(root, "失败诊断.txt") };
    try {
      for (const options of [
        { dialogError: new Error("synthetic save dialog failure") },
        { result, fileSystem: { ...fs, openSync() { throw new Error("EACCES synthetic open failure"); } } },
        { result, fileSystem: { ...fs, writeFileSync() { throw new Error("EACCES synthetic export failure"); } } },
      ]) {
        const messages = await exportDiagnostic(options);
        assert.equal(messages.length, 1);
        assert.ok(messages[0][0].includes("诊断导出未完成"));
        assert.ok(messages[0][1]);
        assert.equal(messages[0][2], "启动-TEST");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("渲染探针不占用产品 GPU 上下文", () => {
  it("WebGL2 检测后立即释放临时上下文，不再检测 WebGL1", () => {
    const calls = [];
    const context = { getExtension: (name) => { calls.push(name); return { loseContext: () => calls.push("released") }; } };
    const document = { createElement: (name) => { calls.push(name); return { getContext: (kind) => { calls.push(kind); return context; } }; } };
    assert.equal(probeWebGL(document), true);
    assert.deepEqual(calls, ["canvas", "webgl2", "WEBGL_lose_context", "released"]);
  });

  it("WebGL1 回退同样释放，扩展未提供时仍如实报告能力", () => {
    let released = 0;
    const context = { getExtension: () => ({ loseContext: () => { released++; } }) };
    assert.equal(probeWebGL({ createElement: () => ({ getContext: (kind) => kind === "webgl" ? context : null }) }), true);
    assert.equal(released, 1);
    assert.equal(probeWebGL({ createElement: () => ({ getContext: () => ({ getExtension: () => null }) }) }), true);
  });

  it("无上下文、创建异常、释放异常均报告不可用", () => {
    assert.equal(probeWebGL({ createElement: () => ({ getContext: () => null }) }), false);
    assert.equal(probeWebGL({ createElement: () => { throw new Error("GPU unavailable"); } }), false);
    assert.equal(probeWebGL({ createElement: () => ({ getContext: () => ({ getExtension: () => ({ loseContext: () => { throw new Error("GPU reset"); } }) }) }) }), false);
  });
});

describe("真实首日引导退出的渲染冒烟", () => {
  function clock() {
    let time = 0;
    return { now: () => time, pause: async (milliseconds) => { time += milliseconds; } };
  }

  it("欢迎层退出的空帧不能跳过下一次 React 提交才出现的引导", async () => {
    const timer = clock();
    let probes = 0;
    const result = await dismissFirstDayGuide(async () => {
      probes++;
      return { supported: true, shown: probes === 3, clicked: probes === 3 };
    }, timer);
    assert.deepEqual(result, { supported: true, shown: true, clicked: true, closed: true });
    assert.ok(probes >= 7);
  });

  it("存在引导入口却一直不出现引导时不能标成退出成功", async () => {
    const result = await dismissFirstDayGuide(async () => ({ supported: true, shown: false, clicked: false }), clock());
    assert.equal(result.closed, false);
    assert.equal(result.shown, false);
  });

  it("点了关闭仍持续覆盖时在原截止时间内失败关闭", async () => {
    const timer = clock();
    const result = await dismissFirstDayGuide(async () => ({ supported: true, shown: true, clicked: true }), timer);
    assert.equal(result.closed, false);
    assert.equal(timer.now(), 10000);
  });

  it("未安装引导内容包时稳定无遮挡仍可验收", async () => {
    const result = await dismissFirstDayGuide(async () => ({ supported: false, shown: false, clicked: false }), clock());
    assert.deepEqual(result, { supported: false, shown: false, clicked: false, closed: true });
  });

  it("缺退出按钮或 renderer 执行失败均不吞异常", async () => {
    await assert.rejects(
      dismissFirstDayGuide(async () => ({ supported: true, shown: true, clicked: false }), clock()),
      /缺少可用退出按钮/u,
    );
    await assert.rejects(dismissFirstDayGuide(async () => { throw new Error("renderer unavailable"); }, clock()),
      /renderer unavailable/u);
    await assert.rejects(dismissFirstDayGuide(async () => ({ shown: "false" }), clock()), /非法状态/u);
  });

  it("renderer 永不返回时也必须到截止即结束且不遗留定时器", async () => {
    let watchdog;
    let probes = 0;
    try {
      const result = await Promise.race([
        dismissFirstDayGuide(() => { probes++; return new Promise(() => {}); }, { timeoutMs: 20 }),
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("guide deadline was not enforced")), 500); }),
      ]);
      assert.equal(result.closed, false);
      assert.equal(probes, 1);
      const timer = clock();
      let lateProbes = 0;
      const late = await dismissFirstDayGuide(async () => {
        lateProbes++;
        if (lateProbes === 3) await timer.pause(10000);
        return { supported: true, shown: lateProbes === 1, clicked: lateProbes === 1 };
      }, timer);
      assert.equal(late.closed, false, "A renderer result delivered after the deadline cannot pass");
    } finally {
      clearTimeout(watchdog);
    }
  });
});

describe("产品截图采用捕获时的可见场景", () => {
  async function capture(states, captureState, sceneName = "workplace-3d") {
    const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    const start = source.indexOf("  async function captureProductScene(sceneName, fileStem) {");
    const end = source.indexOf("\n  const workplaceScene = ", start);
    assert.ok(start > 0 && end > start, "实际场景函数必须可提取");
    let elapsed = 0;
    let probes = 0;
    const context = {
      SAFE_RENDERING: false, logDir: "/isolated-scene", path, Buffer,
      fs: { writeFileSync() {} }, report: { bundle: "ai-pm", actorCount: 14 },
      Date: { now: () => elapsed },
      setTimeout: (resolve, milliseconds) => { elapsed += milliseconds; resolve(); },
      pixelHealth: () => ({ variance: 100, visibleRatio: 1 }),
      win: { webContents: {
        executeJavaScript: async () => {
          const state = states(elapsed, probes++);
          return { ready: true, overlayVisible: false, actors: sceneName.startsWith("report-stage-") ? 15 : 14, labels: [],
            geometry: { scene: { width: 768, height: 440 }, canvas: { width: 768, height: 440 }, contextLost: false, ceoOverlapIds: [] }, ...state };
        },
        capturePage: async () => {
          captureState?.();
          return { toPNG: () => Buffer.from("isolated-scene") };
        },
      } },
    };
    const captureScene = vm.runInNewContext(source.slice(start, end) + "\ncaptureProductScene", context);
    return captureScene(sceneName, "scene");
  }

  it("等待后实际无遮挡且完整时仍通过", async () => {
    const result = await capture(() => ({}));
    assert.equal(result.ready, true);
    assert.equal(result.overlayVisible, false);
    assert.equal(result.actors, 14);
  });

  it("稳定等待中重新出现引导层时拒绝旧无遮挡状态", async () => {
    await assert.rejects(capture(milliseconds => ({ overlayVisible: milliseconds >= 1000 })), /仍被引导层遮挡/u);
  });

  it("稳定等待中卸载场景或员工减少时拒绝旧完整状态", async () => {
    await assert.rejects(capture(milliseconds => ({ ready: milliseconds < 1000 })), /未就绪/u);
    await assert.rejects(capture(milliseconds => ({ actors: milliseconds >= 1000 ? 13 : 14 })), /团队人数不完整/u);
  });

  it("截图捕获期间出现遮罩或内置人名也必须失败", async () => {
    let captured = false;
    await assert.rejects(capture(() => ({ overlayVisible: captured }), () => { captured = true; }), /仍被引导层遮挡/u);
    captured = false;
    await assert.rejects(capture(() => ({ labels: captured ? ["顾云峥"] : [] }), () => { captured = true; }), /泄漏系统内置人名/u);
  });

  it("场景就绪但实际舞台 Canvas 只占 150 像素时不能用整页像素健康转绿", async () => {
    await assert.rejects(capture(() => ({
      geometry: { scene: { width: 768, height: 440 }, canvas: { width: 768, height: 150 }, contextLost: false, ceoOverlapIds: [] },
    }), undefined, "report-stage-3d"), /舞台画布未铺满/u);
  });

  it("负责人固定牌与员工名牌相交、Canvas 缺失或上下文失效时拒绝验收", async () => {
    for (const geometry of [
      { scene: { width: 768, height: 440 }, canvas: { width: 768, height: 440 }, contextLost: false, ceoOverlapIds: ["worker"] },
      { scene: { width: 768, height: 440 }, canvas: null, contextLost: false, ceoOverlapIds: [] },
      { scene: { width: 768, height: 440 }, canvas: { width: 768, height: 440 }, contextLost: true, ceoOverlapIds: [] },
    ]) await assert.rejects(capture(() => ({ geometry })), /名牌相交|画布不可用/u);
  });
});

function fixture(version, withCurrent = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-bootstrap-"));
  const sourceRoot = path.join(root, "payload");
  const supportDir = path.join(root, "support");
  for (const part of ["runtime", "node", "pg", "nats"]) {
    fs.mkdirSync(path.join(sourceRoot, part), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, part, "payload.txt"), `${part}-${version}`);
  }
  fs.writeFileSync(path.join(sourceRoot, "runtime", "VERSION"), version);
  fs.mkdirSync(supportDir, { recursive: true });
  if (withCurrent) {
    for (const part of ["runtime", "node", "pg", "nats"]) {
      fs.mkdirSync(path.join(supportDir, part), { recursive: true });
      fs.writeFileSync(path.join(supportDir, part, "current.txt"), `${part}-old`);
    }
    fs.writeFileSync(path.join(supportDir, "runtime", ".env"), "JWT_SECRET=keep-me\n");
    fs.writeFileSync(path.join(supportDir, "VERSION"), "1.0.0\n");
    fs.writeFileSync(path.join(supportDir, ".bootstrapped"), "done");
  }
  return { root, sourceRoot, supportDir };
}

function transientDirectories(supportDir) {
  return fs.readdirSync(supportDir).filter((name) => /^\.install-(?:staging|backup)-/.test(name));
}

describe("桌面载荷原子装配", () => {
  it("同版本标记不能跳过缺失运行目录、错误运行版本或缺失 Node 的恢复", async () => {
    for (const missing of ["runtime", "runtime-version", "node"]) {
      const f = fixture("2.0.0");
      fs.writeFileSync(path.join(f.supportDir, "VERSION"), "2.0.0\n");
      if (missing === "runtime") fs.rmSync(path.join(f.supportDir, "runtime"), { recursive: true });
      else fs.writeFileSync(path.join(f.supportDir, "runtime", "VERSION"), missing === "runtime-version" ? "1.0.0\n" : "2.0.0\n");
      if (missing === "node") fs.rmSync(path.join(f.supportDir, "node"), { recursive: true });
      const pgData = path.join(f.supportDir, "pgdata");
      fs.mkdirSync(pgData);
      fs.writeFileSync(path.join(pgData, "customer.txt"), "existing-customer-database");
      try {
        await assert.rejects(bootstrap({
          resourcesDir: f.sourceRoot, supportDir: f.supportDir, smoke: true, failAt: "after-first-swap",
        }), /安装故障注入：after-first-swap/u, "必须进入原子恢复，不能停在缺版本/二进制错误");
        assert.equal(fs.readFileSync(path.join(f.supportDir, "VERSION"), "utf8"), "2.0.0\n");
        assert.equal(fs.readFileSync(path.join(pgData, "customer.txt"), "utf8"), "existing-customer-database");
        assert.equal(fs.readFileSync(path.join(f.supportDir, ".bootstrapped"), "utf8"), "done");
        assert.deepEqual(transientDirectories(f.supportDir), []);
        assert.equal(fs.existsSync(path.join(f.supportDir, ".bootstrap-lock")), false);
        if (missing !== "runtime") assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", ".env"), "utf8"), "JWT_SECRET=keep-me\n");
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    }
  });

  it("解析物理路径后向 tar 传相对路径，并为 Windows 跨盘符暂存归档", () => {
    const destination = "D:\\a\\_temp\\wl-smoke\\.payload-cache";
    const sameDrive = tarExtractionPlan(
      "D:\\a\\workloom-im\\release\\resources\\payload.tar.gz",
      destination,
      { pathApi: path.win32, realpath: (value) => value },
    );
    assert.equal(sameDrive.cwd, destination);
    assert.equal(sameDrive.stagedArchive, null);
    assert.equal(path.win32.isAbsolute(sameDrive.archiveArg), false);
    assert.doesNotMatch(sameDrive.archiveArg, /[A-Za-z]:|\\/u);

    const crossDrive = tarExtractionPlan(
      "C:\\Program Files\\WorkLoom\\resources\\payload.tar.gz",
      destination,
      { pathApi: path.win32, realpath: (value) => value },
    );
    assert.equal(crossDrive.cwd, destination);
    assert.equal(crossDrive.archiveArg, ".workloom-payload.tar.gz");
    assert.equal(crossDrive.stagedArchive, path.win32.join(destination, ".workloom-payload.tar.gz"));

    const macSymlink = tarExtractionPlan(
      "/Users/runner/work/workloom-im/resources/payload.tar.gz",
      "/tmp/wl-smoke/.payload-cache",
      {
        pathApi: path.posix,
        realpath: (value) => value.startsWith("/tmp/") ? `/private${value}` : value,
      },
    );
    assert.equal(macSymlink.cwd, "/private/tmp/wl-smoke/.payload-cache");
    assert.equal(macSymlink.archiveArg, "../../../../Users/runner/work/workloom-im/resources/payload.tar.gz");
  });

  it("正式打包入口缺少载荷时在启动任何服务前失败关闭", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-packaged-payload-missing-"));
    const resourcesDir = path.join(root, "resources");
    const supportDir = path.join(root, "support");
    fs.mkdirSync(resourcesDir, { recursive: true });
    try {
      await assert.rejects(
        bootstrap({ resourcesDir, supportDir, smoke: true }),
        /载荷版本标记缺失/u,
      );
      assert.equal(fs.existsSync(path.join(supportDir, ".bootstrap-lock")), false);
      assert.equal(fs.existsSync(path.join(supportDir, "runtime")), false);
      assert.equal(fs.existsSync(path.join(supportDir, "node")), false);
      assert.equal(fs.existsSync(path.join(supportDir, "pg")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("正式打包入口不会把源码 dist-payload 双重嵌套误认作 Resources", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-packaged-no-double-payload-"));
    const resourcesDir = path.join(root, "resources");
    const supportDir = path.join(root, "support");
    fs.mkdirSync(path.join(resourcesDir, "dist-payload", "runtime"), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, "dist-payload", "PAYLOAD_VERSION"), "9.9.9\n");
    fs.writeFileSync(path.join(resourcesDir, "dist-payload", "runtime", "VERSION"), "9.9.9\n");
    fs.writeFileSync(path.join(resourcesDir, "dist-payload.tar.gz"), "not-a-release-resource\n");
    try {
      await assert.rejects(
        bootstrap({ resourcesDir, supportDir, smoke: true }),
        /载荷版本标记缺失/u,
      );
      assert.equal(fs.existsSync(path.join(supportDir, "runtime")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("完整暂存后换入；提交前可回滚，提交后清理临时目录", () => {
    const f = fixture("2.0.0");
    const tx = installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      previousEnv: Buffer.from("JWT_SECRET=keep-me\n"),
    });
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", "payload.txt"), "utf8"), "runtime-2.0.0");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", ".env"), "utf8"), "JWT_SECRET=keep-me\n");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "VERSION"), "utf8").trim(), "2.0.0");
    assert.equal(fs.existsSync(path.join(f.supportDir, ".bootstrapped")), false);
    tx.commit();
    assert.deepEqual(transientDirectories(f.supportDir), []);
  });

  it("提交清理故障发生在不可逆边界之后，不会重新开放旧载荷回滚", () => {
    const f = fixture("2.0.0");
    const tx = installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      failAt: "during-commit-cleanup",
    });
    tx.commit();
    tx.rollback();
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", "payload.txt"), "utf8"), "runtime-2.0.0");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "VERSION"), "utf8").trim(), "2.0.0");
  });

  it("换入第一项后故障会恢复旧版目录、版本和首航状态", () => {
    const f = fixture("2.0.0");
    assert.throws(() => installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      failAt: "after-first-swap",
    }), /故障注入/);
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", "current.txt"), "utf8"), "runtime-old");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "VERSION"), "utf8").trim(), "1.0.0");
    assert.equal(fs.readFileSync(path.join(f.supportDir, ".bootstrapped"), "utf8"), "done");
    assert.deepEqual(transientDirectories(f.supportDir), []);
  });

  it("首装暂存失败不会留下半套运行时", () => {
    const f = fixture("2.0.0", false);
    assert.throws(() => installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      failAt: "after-stage",
    }), /故障注入/);
    for (const part of ["runtime", "node", "pg", "nats"]) assert.equal(fs.existsSync(path.join(f.supportDir, part)), false);
    assert.equal(fs.existsSync(path.join(f.supportDir, "VERSION")), false);
    assert.deepEqual(transientDirectories(f.supportDir), []);
  });

  it("安装阶段检查点以机器可读中文状态落盘", () => {
    const f = fixture("2.0.0", false);
    writeInstallCheckpoint(f.supportDir, {
      status: "running", phase: "database", detail: "正在准备数据库",
      recoverable: true, percent: 70, etaSeconds: 38,
    });
    const state = JSON.parse(fs.readFileSync(path.join(f.supportDir, "install-state.json"), "utf8"));
    assert.equal(state.schemaVersion, "workloom.install-state/v1");
    assert.equal(state.phase, "database");
    assert.equal(state.recoverable, true);
    assert.equal(state.percent, 70);
    assert.equal(state.etaSeconds, 38);
  });

  it("启动页使用确定进度语义，不再显示循环假进度", () => {
    const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    assert.match(source, /aria-valuenow=/);
    assert.match(source, /进度按已完成的启动检查点更新/);
    assert.doesNotMatch(source, /animation:slide/);
  });

  it("源码主进程只复用已验活服务，正式安装包与渲染冒烟不能绕过载荷", () => {
    const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    assert.match(source, /if \(SOURCE_MODE\)[\s\S]*if \(app\.isPackaged\)[\s\S]*正式安装包禁止源码模式/u);
    assert.match(source, /if \(SOURCE_MODE\)[\s\S]*if \(RENDER_SMOKE\)[\s\S]*源码模式禁止执行发布渲染冒烟/u);
    assert.match(source, /else \{[\s\S]*handle = await bootstrap\(\{[\s\S]*resourcesDir/u);
  });

  it("发布渲染冒烟使用稳定动作标记走完真实欢迎流程", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    const welcomeSource = fs.readFileSync(path.join(__dirname, "../../web/src/components/WelcomeCeremony.tsx"), "utf8");
    // 2026-09-20：仪式收尾的 V4 主弹窗（enter-system 按钮行）已删除；
    // 冒烟只保留「直接进入」这一个稳定动作，随后等待欢迎覆盖层消失。
    assert.ok(mainSource.includes('data-welcome-action="skip-team"'));
    assert.ok(welcomeSource.includes('data-welcome-action="skip-team"'));
    assert.doesNotMatch(mainSource, /data-welcome-action="enter-system"/u);
    assert.doesNotMatch(welcomeSource, /data-welcome-action="enter-system"/u);
    assert.doesNotMatch(mainSource, /textContent\?\.includes\(['"](?:跳过仪式|进入系统)/u);
  });
});

describe("桌面 PostgreSQL 实例归属与端口契约", () => {
  it("严格拒绝空白、小数、非数字和越界端口", () => {
    assert.equal(parseDesktopPort("WORKLOOM_PG_PORT", 5432, {}), 5432);
    assert.equal(parseDesktopPort("WORKLOOM_PG_PORT", 5432, { WORKLOOM_PG_PORT: "55432" }), 55432);
    for (const value of ["", " 5432", "5432 ", "5432.5", "port", "0", "65536"]) {
      assert.throws(
        () => parseDesktopPort("WORKLOOM_PG_PORT", 5432, { WORKLOOM_PG_PORT: value }),
        /1 到 65535/u,
      );
    }
  });

  it("只有 pg_ctl 确认运行且 postmaster 数据目录与端口同时匹配才允许复用", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-pg-owner-"));
    const pgData = path.join(root, "pgdata");
    fs.mkdirSync(pgData);
    fs.writeFileSync(path.join(pgData, "postmaster.pid"), `31415\n${pgData}\n1\n55432\n/tmp\n127.0.0.1\n`);
    const calls = [];
    try {
      assert.equal(ownedPostgresRunning({
        pgCtl: "/runtime/pg_ctl",
        pgData,
        expectedPort: 55432,
        runCommand(command, args) { calls.push({ command, args }); return { code: 0 }; },
      }), true);
      assert.deepEqual(calls, [{ command: "/runtime/pg_ctl", args: ["status", "-D", pgData] }]);
      assert.throws(() => assertPostmasterIdentity(pgData, 55433), /运行端口 55432/u);

      const foreign = path.join(root, "foreign");
      fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(pgData, "postmaster.pid"), `31415\n${foreign}\n1\n55432\n/tmp\n127.0.0.1\n`);
      assert.throws(() => assertPostmasterIdentity(pgData, 55432), /数据目录不属于当前产品/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pg_ctl 未确认运行时不读取残留 PID，也不把端口监听者当作自有实例", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-pg-stopped-"));
    try {
      assert.equal(ownedPostgresRunning({
        pgCtl: "/runtime/pg_ctl",
        pgData: path.join(root, "missing-pgdata"),
        expectedPort: 55432,
        runCommand() { return { code: 3 }; },
      }), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("退出前重新复验实例归属，PID 文件被替换时绝不发送 stop", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-pg-stop-owner-"));
    const pgData = path.join(root, "pgdata");
    const foreign = path.join(root, "foreign");
    fs.mkdirSync(pgData);
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(pgData, "postmaster.pid"), `31415\n${foreign}\n1\n55432\n/tmp\n127.0.0.1\n`);
    let stops = 0;
    try {
      assert.throws(() => stopOwnedPostgres({
        pgCtl: "/test-only/pg_ctl",
        pgData,
        expectedPort: 55432,
        logFile: path.join(root, "pg.log"),
        runCommand() { return { code: 0 }; },
        stopCommand() { stops += 1; return { code: 0 }; },
      }), /数据目录不属于当前产品/u);
      assert.equal(stops, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("托管环境只重写数据库与服务端口，保留其他用户配置", () => {
    const scheme = "postgres://";
    const original = [
      `DATABASE_URL=${scheme}postgres:test-only@localhost:5432/workloom`,
      "APP_DB_PASSWORD=test-only",
      "GATEWAY_DB_PASSWORD=test-only",
      `DATABASE_APP_URL=${scheme}workloom_app:test-only@localhost:5432/workloom`,
      `DATABASE_GATEWAY_URL=${scheme}workloom_gateway:test-only@localhost:5432/workloom`,
      "SERVER_PORT=8787",
      "WEB_PORT=5173",
      "LLM_MODEL=keep-user-choice",
      "",
    ].join("\n");
    const result = buildDesktopEnvironment(original, {
      runtimeDir: path.resolve(__dirname, "../../../"),
      pgPort: 55432,
      serverPort: 18787,
      webPort: 15173,
      adminPassword: "test-only",
      appPassword: "test-only",
      gatewayPassword: "test-only",
    });
    assert.match(result.text, /^LLM_MODEL=keep-user-choice$/mu);
    assert.match(result.text, /^SERVER_PORT=18787$/mu);
    assert.match(result.text, /^WEB_PORT=15173$/mu);
    for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
      const value = result.text.match(new RegExp(`^${key}=(.*)$`, "mu"))?.[1];
      assert.equal(new URL(value).hostname, "127.0.0.1");
      assert.equal(new URL(value).port, "55432");
    }
  });

  it("首装与升级分别从当前载荷生成桥注册表，不引用其他实例的运行目录", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-bridge-config-"));
    const source = path.resolve(__dirname, "../../../bundles/ai-video/connectors/bgm-bridge/executor.ts");
    const configuration = {
      pgPort: 55432, serverPort: 18787, webPort: 15173,
      adminPassword: "test-only", appPassword: "test-only", gatewayPassword: "test-only",
    };
    try {
      let previous = "LLM_MODEL=keep-user-choice\n";
      for (const directory of ["首装 runtime", "升级 runtime"]) {
        const runtimeDir = path.join(root, directory);
        const executor = path.join(runtimeDir, "bundles", "ai-video", "connectors", "bgm-bridge", "executor.ts");
        fs.mkdirSync(path.dirname(executor), { recursive: true });
        fs.copyFileSync(source, executor);
        const result = buildDesktopEnvironment(previous, { ...configuration, runtimeDir });
        assert.equal(result.values.WORKLOOM_TOOL_EXECUTOR_MODULES,
          `${executor}#createBgmBridgeExecutor#bgmread.*|bgmwrite.*#http://127.0.0.1:9775`);
        assert.ok(result.text.includes(`WORKLOOM_TOOL_EXECUTOR_MODULES=${result.values.WORKLOOM_TOOL_EXECUTOR_MODULES}\n`));
        assert.match(result.text, /^LLM_MODEL=keep-user-choice$/mu);
        previous = result.text;
      }
      const emptyRuntime = path.join(root, "无连接器 runtime");
      fs.mkdirSync(emptyRuntime);
      const empty = buildDesktopEnvironment("LLM_MODEL=keep-user-choice\n", { ...configuration, runtimeDir: emptyRuntime });
      assert.equal(empty.values.WORKLOOM_TOOL_EXECUTOR_MODULES, undefined);
      assert.match(empty.text, /^LLM_MODEL=keep-user-choice$/mu);
      assert.throws(() => buildDesktopEnvironment("", { ...configuration, runtimeDir: "relative/runtime" }), /运行目录必须为绝对路径/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("桌面本机渲染子进程的 Node 路径", () => {
  it("干净 GUI PATH 下仍能启动当前随包 Node，且保留系统工具路径", () => {
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const inheritedPath = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin";
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
    const env = withBundledNodePath({ ...baseEnv, [pathKey]: inheritedPath }, process.execPath);
    assert.equal(env[pathKey], `${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`);
    const child = spawnSync("node", ["-p", "process.execPath"], { env, encoding: "utf8" });
    assert.equal(child.status, 0, String(child.stderr || child.error || ""));
    assert.equal(fs.realpathSync(child.stdout.trim()), fs.realpathSync(process.execPath));
  });

  it("Windows 只传一个不区分大小写的 Path；POSIX 不改其他同名变量", () => {
    const win = withBundledNodePath(
      { Path: "C:\\Windows\\System32", PATH: "C:\\shadow", KEEP: "yes" },
      "C:\\Program Files\\WorkLoom\\node\\node.exe", "win32",
    );
    assert.equal(win.Path, "C:\\Program Files\\WorkLoom\\node;C:\\Windows\\System32");
    assert.equal(Object.keys(win).filter((key) => key.toLowerCase() === "path").length, 1);
    assert.equal(win.KEEP, "yes");
    const posix = withBundledNodePath({ PATH: "/usr/bin", Path: "preserve" }, "/opt/workloom/node/bin/node", "darwin");
    assert.equal(posix.PATH, "/opt/workloom/node/bin:/usr/bin");
    assert.equal(posix.Path, "preserve");
  });
});

describe("桌面 PostgreSQL 凭据状态与 SCRAM 围栏", () => {
  function deterministicRandom() {
    let value = 1;
    return (size) => Buffer.alloc(size, value++);
  }

  function boundIdentity(supportDir, port = 55432) {
    const pgData = path.join(supportDir, "pgdata");
    return {
      systemIdentifier: "7654321098765432109",
      dataDirectory: pgData,
      hbaFile: path.join(pgData, "pg_hba.conf"),
      port,
    };
  }

  it("0600 状态文件生成三份互异随机凭据，重复启动不轮换", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-db-state-"));
    try {
      const first = ensureDatabaseState(root, {
        legacyOwnerPasswords: ["test-only-legacy"],
        randomBytes: deterministicRandom(),
      });
      assert.equal(first.created, true);
      assertPrivateFile(first.file);
      assert.equal(new Set(Object.values(first.state.credentials)).size, 3);
      assert.equal(first.state.legacyOwnerPasswords[0], "test-only-legacy");
      const second = ensureDatabaseState(root, {
        randomBytes() { throw new Error("existing state must not rotate"); },
      });
      assert.equal(second.created, false);
      assert.deepEqual(second.state.credentials, first.state.credentials);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("损坏状态失败关闭；绑定 system_identifier 后才能完成并清除旧凭据", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-db-bind-"));
    try {
      const record = ensureDatabaseState(root, {
        legacyOwnerPasswords: ["test-only-legacy"],
        randomBytes: deterministicRandom(),
      });
      const bound = bindDatabaseState(record.file, record.state, boundIdentity(root));
      assert.equal(bound.cluster.systemIdentifier, "7654321098765432109");
      assert.throws(
        () => bindDatabaseState(record.file, bound, { ...boundIdentity(root), systemIdentifier: "7654321098765432110" }),
        /systemIdentifier 与运行实例不一致/u,
      );
      const complete = completeDatabaseHardening(record.file, bound);
      assert.equal(complete.auth.status, "scram-sha-256");
      assert.deepEqual(complete.legacyOwnerPasswords, []);

      fs.writeFileSync(record.file, "{broken", { mode: 0o600 });
      assert.throws(() => ensureDatabaseState(root), /状态损坏/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pending 状态可从恢复后的旧配置补充候选；hardened 后绝不重新收录", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-db-recovery-"));
    try {
      const first = ensureDatabaseState(root, { randomBytes: deterministicRandom() });
      assert.deepEqual(first.state.legacyOwnerPasswords, []);
      const recovered = ensureDatabaseState(root, {
        legacyOwnerPasswords: ["test-only-recovered", "test-only-recovered"],
      });
      assert.deepEqual(recovered.state.legacyOwnerPasswords, ["test-only-recovered"]);
      const bound = bindDatabaseState(recovered.file, recovered.state, boundIdentity(root));
      completeDatabaseHardening(recovered.file, bound);
      const hardened = ensureDatabaseState(root, {
        legacyOwnerPasswords: ["test-only-must-not-return"],
      });
      assert.deepEqual(hardened.state.legacyOwnerPasswords, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("initdb 只接受 pwfile + SCRAM，HBA 只允许本机 SCRAM", () => {
    const args = secureInitdbArgs("/test-only/pgdata", "/test-only/pwfile");
    assert.ok(args.includes("--auth-host=scram-sha-256"));
    assert.ok(args.includes("--auth-local=scram-sha-256"));
    assert.ok(args.includes("--pwfile=/test-only/pwfile"));
    assert.equal(args.some((arg) => /trust|md5/iu.test(arg)), false);

    const hba = renderStrictPgHba();
    assert.match(hba, /^local all all scram-sha-256$/mu);
    assert.match(hba, /^host all all 127\.0\.0\.1\/32 scram-sha-256$/mu);
    assert.match(hba, /^host all all ::1\/128 scram-sha-256$/mu);
    assert.doesNotMatch(hba, /\b(?:trust|md5)\b|0\.0\.0\.0|::\/0/iu);
  });

  it("pending 迁移复验失败会原子恢复旧 HBA 并再次 reload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-hba-rollback-"));
    const pgData = path.join(root, "pgdata");
    fs.mkdirSync(pgData);
    const original = "host all all 127.0.0.1/32 trust\n";
    fs.writeFileSync(path.join(pgData, "pg_hba.conf"), original);
    const calls = [];
    try {
      assert.throws(() => enforceStrictPgHba({
        pgData,
        pgCtl: "/test-only/pg_ctl",
        rollbackOnFailure: true,
        forceReload: true,
        runCommand(command, args) { calls.push({ command, args }); return { code: 0 }; },
        verifyCommand() { return { code: 1 }; },
      }), /新凭据复验失败/u);
      assert.equal(fs.readFileSync(path.join(pgData, "pg_hba.conf"), "utf8"), original);
      assert.equal(calls.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("即使磁盘 HBA 未变化也强制 reload，再以正反向凭据复验结果为准", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-hba-reload-"));
    const pgData = path.join(root, "pgdata");
    fs.mkdirSync(pgData);
    fs.writeFileSync(path.join(pgData, "pg_hba.conf"), renderStrictPgHba());
    let reloads = 0;
    try {
      const result = enforceStrictPgHba({
        pgData,
        pgCtl: "/test-only/pg_ctl",
        rollbackOnFailure: false,
        forceReload: true,
        runCommand() { reloads += 1; return { code: 0 }; },
        verifyCommand() { return { code: 0 }; },
      });
      assert.equal(result.changed, false);
      assert.equal(reloads, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("源码固定先提交新 payload 再创建状态或改库，且不含 trust initdb", () => {
    const source = fs.readFileSync(path.join(__dirname, "bootstrap.cjs"), "utf8");
    const commit = source.indexOf("payloadTransaction?.commit();");
    const stateMutation = source.indexOf("const databaseStateRecord = ensureDatabaseState");
    const databaseMutation = source.indexOf('runDatabaseHelper("prepare"');
    assert.ok(commit > 0 && commit < stateMutation && stateMutation < databaseMutation);
    assert.doesNotMatch(source, /--auth=trust/u);
    assert.match(source, /password_encryption=scram-sha-256/u);
  });

  it("payload commit 前用内置 Node 语法检查安全 helper，校验失败立即阻断", () => {
    const calls = [];
    validateDatabaseHelper("/test-only/node", "/test-only/helper.mjs", (command, args) => {
      calls.push({ command, args });
      return { code: 0, out: "", err: "" };
    });
    assert.deepEqual(calls, [{
      command: "/test-only/node",
      args: ["--check", "/test-only/helper.mjs"],
    }]);
    assert.throws(
      () => validateDatabaseHelper("/test-only/node", "/test-only/helper.mjs", () => ({ code: 1, err: "test-only syntax" })),
      /语法校验失败/u,
    );
    const source = fs.readFileSync(path.join(__dirname, "bootstrap.cjs"), "utf8");
    assert.ok(source.indexOf("validateDatabaseHelper(NODE_BIN, DB_HELPER)") < source.indexOf("payloadTransaction?.commit();"));
  });

  it("所有 migrate 入口在轮换 app/gateway 角色前固定本会话 SCRAM", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../../scripts/migrate.ts"), "utf8");
    const scram = source.indexOf("SET password_encryption = 'scram-sha-256'");
    const rotation = source.indexOf("const roles:");
    assert.ok(scram > 0 && scram < rotation);
  });
});

describe("应急浏览器壳与正式 Electron 共用安全引导", () => {
  it("原子单实例锁拒绝活进程，并可接管死进程遗留锁", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-bootstrap-lock-"));
    let byte = 1;
    const randomBytes = (size) => Buffer.alloc(size, byte++);
    try {
      const first = acquireBootstrapLock(root, {
        pid: 41001, randomBytes, isProcessAlive: () => true,
      });
      const ownerFile = path.join(first.lockDir, "owner.json");
      assertPrivateFile(ownerFile);
      assert.throws(
        () => acquireBootstrapLock(root, {
          pid: 41002, randomBytes, isProcessAlive: () => true,
        }),
        /已在启动或运行/u,
      );

      const recovered = acquireBootstrapLock(root, {
        pid: 41003, randomBytes, isProcessAlive: () => false,
      });
      assert.equal(first.release(), false);
      assert.equal(recovered.release(), true);
      assert.equal(fs.existsSync(path.join(root, ".bootstrap-lock")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("两端旧启动器只委托 bootstrap，不再维护 trust/helper 分支", () => {
    const macLauncher = fs.readFileSync(
      path.join(__dirname, "../WorkLoom.app/Contents/MacOS/WorkLoom"),
      "utf8",
    );
    const windowsLauncher = fs.readFileSync(
      path.join(__dirname, "../windows/WorkLoom.bat"),
      "utf8",
    );
    for (const source of [macLauncher, windowsLauncher]) {
      assert.match(source, /bootstrap\.cjs/u);
      assert.doesNotMatch(source, /--auth(?:=|\s+)trust|desktop-bootstrap-db\.mjs/iu);
    }
    assert.match(windowsLauncher, /set "RESOURCES=%~dp0\."/u);
    assert.doesNotMatch(windowsLauncher, /set "RESOURCES=%~dp0"/u);

    const macPack = fs.readFileSync(path.join(__dirname, "../../../scripts/pack-macos.sh"), "utf8");
    const windowsPack = fs.readFileSync(path.join(__dirname, "../../../scripts/pack-windows.sh"), "utf8");
    assert.match(macPack, /electron\/bootstrap\.cjs[^\n]+Resources\/bootstrap\.cjs/u);
    assert.match(windowsPack, /electron\/bootstrap\.cjs[^\n]+PKG\/bootstrap\.cjs/u);
    assert.match(macPack, /Resources\/pg\/bin/u);
    assert.doesNotMatch(macPack, /Resources\/pg\/Postgres\.app/u);
  });

  it("浏览器壳按平台使用无 shell 拼接的固定打开命令", () => {
    const calls = [];
    const spawnCommand = (command, args, options) => {
      calls.push({ command, args, options });
      return { on() {}, unref() {} };
    };
    openExternalUrl("http://127.0.0.1:5173", { platform: "darwin", spawnCommand });
    openExternalUrl("http://127.0.0.1:5173", { platform: "win32", spawnCommand });
    assert.deepEqual(calls[0].command, "open");
    assert.deepEqual(calls[0].args, ["http://127.0.0.1:5173"]);
    assert.deepEqual(calls[1].command, "cmd.exe");
    assert.deepEqual(calls[1].args, ["/d", "/s", "/c", "start", "", "http://127.0.0.1:5173"]);
    assert.equal(calls.every(({ options }) => options.detached && options.stdio === "ignore"), true);
  });

  it("CLI 在启动前注册 INT/TERM/HUP，并用 AbortSignal 驱动初始化清理", () => {
    const source = fs.readFileSync(path.join(__dirname, "bootstrap.cjs"), "utf8");
    const signalRegistration = source.indexOf('for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"])');
    const invocation = source.indexOf("bootstrap({ resourcesDir, supportDir, smoke, signal: abortController.signal })");
    assert.ok(signalRegistration > 0 && signalRegistration < invocation);
    assert.match(source, /if \(abortSignal\?\.aborted\) throw new Error/u);
  });
});
