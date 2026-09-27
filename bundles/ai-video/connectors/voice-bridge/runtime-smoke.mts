/**
 * 配音工位真机 smoke：真实 HTTP 桥 + 真实 ffmpeg + 真实围栏求值（默认 mock 引擎，`--real` 切真机引擎）。
 *
 *   node_modules/.bin/tsx bundles/ai-video/connectors/voice-bridge/runtime-smoke.mts [--real] [--mic]
 *
 * 为什么默认走 mock 引擎：CI 与本地干跑要的是**桥与内核的行为**（路径监狱/质量门/时窗适配/混音/回执），
 * 模型推理慢且依赖权重；`--real` 才连本机引擎（真机验收口径，另见 kit/selftest.sh）。
 * 六个场景：clean（建档→播报→配音→核验）／overwrite（覆盖原片）／missing-text（缺逐字稿）／
 *           fence（围栏语义）／outage（工位不可达）／mic（可选：真实麦克风录音，仅 --mic）。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { evalCondition } from "../../../../packages/base/fence-engine/expr.js";
import { createVoiceBridgeExecutor } from "./executor.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const ARGS = new Set(process.argv.slice(2));
const REAL = ARGS.has("--real");
const WITH_MIC = ARGS.has("--mic");

const results: Array<{ scenario: string; ok: boolean; detail: string }> = [];
function record(scenario: string, ok: boolean, detail: string) {
  results.push({ scenario, ok, detail });
  process.stdout.write(`${ok ? "✓" : "✗"} ${scenario}：${detail}\n`);
}

async function run(bin: string, args: string[], { timeoutMs = 300_000 } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

async function ffmpeg(args: string[]) {
  const bins = process.env.WORKLOOM_BGM_FFMPEG_PATH ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const result = await run(bins, ["-hide_banner", "-loglevel", "error", ...args]);
  if (result.code !== 0) throw new Error(`ffmpeg 失败：${result.stderr.split("\n").filter(Boolean).slice(-2).join(" | ")}`);
}

async function probeDuration(file: string): Promise<number> {
  const bins = process.env.WORKLOOM_BGM_FFPROBE_PATH ?? process.env.FFPROBE_PATH ?? "ffprobe";
  const result = await run(bins, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { timeoutMs: 60_000 });
  return Number(result.stdout.trim());
}

async function waitForBridge(url: string, token: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` } });
      if (response.ok) return true;
    } catch {
      // 未就绪，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function main() {
  const station = await fsp.mkdtemp(path.join(os.tmpdir(), "voice-smoke-"));
  const mediaDir = path.join(station, "media");
  await fsp.mkdir(mediaDir, { recursive: true });
  const port = 9800 + Math.floor(Math.random() * 150);
  const token = `smoke-${createHash("sha1").update(station).digest("hex").slice(0, 12)}`;
  const engine = REAL ? (process.env.WORKLOOM_VOICE_ENGINE ?? "mlx") : "mock";

  process.stdout.write(`\n=== 配音工位 runtime-smoke（engine=${engine}${WITH_MIC ? " +mic" : ""}）===\n`);

  const server = spawn(
    process.execPath,
    [path.join(HERE, "server.mjs")],
    {
      env: {
        ...process.env,
        WORKLOOM_VOICE_STATION_DIR: station,
        WORKLOOM_VOICE_ALLOWED_ROOTS: mediaDir,
        WORKLOOM_VOICE_BRIDGE_PORT: String(port),
        WORKLOOM_VOICE_BRIDGE_TOKEN: token,
        WORKLOOM_VOICE_BRIDGE_TENANT: "ws-video",
        WORKLOOM_VOICE_ENGINE: engine,
        ...(REAL ? {} : { WORKLOOM_VOICE_ENGINE_URL: "http://127.0.0.1:1" }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  server.stdout.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    if (!(await waitForBridge(baseUrl, token))) throw new Error(`桥未就绪：${logs.join("").slice(-300)}`);
    const executor = createVoiceBridgeExecutor({ baseUrl, token, tenantId: "ws-video", timeoutMs: REAL ? 1_800_000 : 300_000 });

    /* ---------- 场景 1：clean（建档 → 播报 → 配音 → 核验） ---------- */
    const health = await executor("voiceread.health", {});
    record("health", health.receipt.synced === true, `engine=${JSON.stringify((health.result.engine as { kind?: string })?.kind)}`);

    // 参考音频：用 mock 引擎合成一段（真机模式下由 --mic 或既有档案提供；此处仍用 mock 生成参考，保证可复现）
    const mockConfig = { kind: "mock", baseUrl: "http://127.0.0.1:1", ttsModel: "mock", asrModel: "mock", language: "Chinese", asr: false, referenceInjection: true, timeoutMs: 60_000 };
    void mockConfig;
    const refPath = path.join(mediaDir, "reference.wav");
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=210:duration=6:sample_rate=24000", "-af", "volume=0.2,tremolo=f=5:d=0.7", "-ac", "1", "-ar", "24000", "-y", refPath]);
    const refSha = createHash("sha256").update(await fsp.readFile(refPath)).digest("hex");

    const consent = await executor("voicewrite.consent", {
      profile: "zh-smoke", speaker_type: "synthetic", scope: "internal", declared_by: "runtime-smoke",
    });
    record("consent", consent.receipt.synced === true, `consent_file=${path.basename(String(consent.result.consent_file ?? ""))}`);

    const register = await executor("voicewrite.register", {
      profile: "zh-smoke",
      reference: refPath,
      ref_text: "这是一段用于自检的参考音频逐字稿。",
      speaker_label: "smoke",
      allow_low_quality: true,
    });
    record("register", register.receipt.sha256 === refSha, `reference_sha256=${String(register.receipt.sha256 ?? "").slice(0, 12)}…`);

    const speak = await executor("voicewrite.speak", {
      profile: "zh-smoke",
      text: "您好，我是小织，这是配音工位的自检播报。",
      out: path.join(station, "deliveries", "smoke-speak.wav"),
    });
    record("speak", speak.receipt.synced === true && String(speak.result.out ?? "").endsWith(".wav"), `lufs=${speak.result.lufs} duration=${speak.result.duration_sec}s`);

    const verify = await executor("voicewrite.verify", {
      input: String(speak.result.out),
      expect_text: "您好，我是小织，这是配音工位的自检播报。",
      strict: false,
      lufs: Number(speak.result.lufs ?? -16),
    });
    const verifiedText = verify.result.checked as { text_match_status?: string } | undefined;
    record("verify", REAL
      ? verify.receipt.synced === true && verify.result.status === "passed" && verifiedText?.text_match_status === "passed"
      : verify.receipt.synced === false && verify.result.status === "unverified" && verifiedText?.text_match_status === "unverified",
    `status=${verify.result.status} text_match=${verifiedText?.text_match_status}（${REAL ? "真实 ASR" : "mock 无 ASR，预期未核实"}）`);

    const disabled = await executor("voicewrite.verify", {
      input: String(speak.result.out), expect_text: "您好，我是小织，这是配音工位的自检播报。", round_trip: false, strict: false,
    });
    record("verify-disabled", disabled.receipt.synced === false && disabled.result.status === "unverified",
      `status=${disabled.result.status} reason=${JSON.stringify(disabled.result.unverified ?? [])}`);
    const declared = await executor("voicewrite.verify", { input: refPath, speech_expected: false });
    record("verify-no-speech", declared.receipt.synced === true
      && (declared.result.checked as { text_match_status?: string })?.text_match_status === "not_applicable",
    "显式合成测试音无台词，物理测量有效才放行");

    const video = path.join(mediaDir, "smoke-film.mp4");
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=320:duration=6",
      "-filter_complex", "[1:a]volume=0.05[a]", "-map", "0:v", "-map", "[a]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", "-y", video,
    ]);
    const dubOut = path.join(station, "deliveries", "smoke-dubbed.mp4");
    const dub = await executor("voicewrite.dub", {
      video,
      out: dubOut,
      profile: "zh-smoke",
      segments: [
        { start: 0.2, end: 2.6, text: "第一段自检配音。" },
        { start: 3.0, end: 5.6, text: "第二段自检配音。" },
      ],
      policy: "keep-dialogue",
      lufs: -14,
    });
    const dubDuration = fs.existsSync(dubOut) ? await probeDuration(dubOut) : 0;
    record(
      "dub",
      dub.receipt.synced === true && Math.abs(dubDuration - 6) <= 0.25,
      `drift=${dub.result.drift_sec}s out=${dubDuration.toFixed(3)}s policy=${dub.result.policy}`,
    );

    /* ---------- 场景 2：覆盖原片一律拒绝 ---------- */
    const overwrite = await executor("voicewrite.dub", { video, out: video, profile: "zh-smoke", text: "覆盖测试" });
    record(
      "overwrite",
      overwrite.receipt.synced === false && String(overwrite.result.error) === "overwrite_source_forbidden",
      `error=${overwrite.result.error}`,
    );

    /* ---------- 场景 3：缺逐字稿且引擎无 ASR → 明确拒绝（不猜） ---------- */
    const noTranscript = await executor("voicewrite.register", { profile: "zh-smoke-2", reference: refPath, auto_transcribe: false, allow_low_quality: true });
    record(
      "missing-text",
      noTranscript.receipt.synced === false && String(noTranscript.result.error) === "ref_text_required",
      `error=${noTranscript.result.error}`,
    );

    /* ---------- 场景 4：围栏语义（真实求值器） ---------- */
    const pack = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "bundles/ai-video/fences/ai-video-voice.yml"), "utf8")) as {
      rules: Array<{ rule_id: string; when: string }>;
    };
    const whenOf = (id: string) => pack.rules.find((rule) => rule.rule_id === id)!.when;
    const evaluate = (id: string, params: Record<string, unknown>, context: Record<string, unknown> = {}) =>
      evalCondition(whenOf(id), { params, context } as never) as boolean;
    const fenceChecks: Array<[string, boolean, string]> = [
      ["G-VOICE1 无授权挂起", evaluate("G-VOICE1", { profile: "zh-x" }) === true, "consent_declared 缺失 → review"],
      ["G-VOICE1 内部声明放行", evaluate("G-VOICE1", { consent_declared: true, consent_scope: "internal" }) === false, "declared+internal → 放行"],
      ["G-VOICE2 覆盖原片阻断", evaluate("G-VOICE2", { out: "/a.mp4", video: "/a.mp4" }) === true, "同路径 → block"],
      ["G-VOICE2 正常配音不误杀", evaluate("G-VOICE2", { out: "/b.mp4", video: "/a.mp4" }) === false, "不同路径 → 放行"],
      ["G-VOICE3 关校验阻断", evaluate("G-VOICE3", { verify: false }) === true, "verify=false → block"],
      ["G-VOICE5 声纹出域阻断", evaluate("G-VOICE5", { upload_voiceprint: true }) === true, "上传声纹 → block"],
      ["G-VOICE6 未授权外发挂起", evaluate("G-VOICE6", { publish_external: true, consent_scope: "internal" }) === true, "外发+internal → review"],
    ];
    const fenceOk = fenceChecks.every(([, ok]) => ok);
    record("fence", fenceOk, fenceChecks.map(([name, ok]) => `${ok ? "✓" : "✗"}${name}`).join(" "));

    /* ---------- 场景 5：工位不可达 → 软失败不伪造 ---------- */
    const offline = createVoiceBridgeExecutor({ baseUrl: "http://127.0.0.1:1", token, softFailures: true, timeoutMs: 5_000 });
    const outage = await offline("voicewrite.speak", { text: "离线测试" });
    record("outage", outage.receipt.synced === false, `error=${outage.result.error}`);

    /* ---------- 场景 6（可选）：真实麦克风录音 ---------- */
    if (WITH_MIC) {
      const recorded = await executor("voicewrite.record", { out: path.join(station, "captures", "mic.wav"), seconds: 5 });
      const gate = recorded.result.gate as { ok?: boolean; reasons?: string[] } | undefined;
      record(
        "mic",
        fs.existsSync(String(recorded.result.reference ?? "")),
        `gate_ok=${gate?.ok} reasons=${JSON.stringify(gate?.reasons ?? [])}`,
      );
    }
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const failed = results.filter((item) => !item.ok);
  process.stdout.write(`\n${failed.length === 0 ? "✓" : "✗"} runtime-smoke ${results.length - failed.length}/${results.length} 通过`);
  process.stdout.write(`（工作目录：${station}${failed.length === 0 ? "，已保留供复核" : ""}）\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`runtime-smoke 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
