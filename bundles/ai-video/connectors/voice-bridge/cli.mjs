#!/usr/bin/env node
/**
 * voice-cli —— 配音工位命令行（配音师数字员工的"手"，也是人类快速自检的入口）。
 *
 * 用法：
 *   voice-cli health
 *   voice-cli devices
 *   voice-cli voices
 *   voice-cli probe     --in clip.mp4
 *   voice-cli consent   --profile zh-xiaozhi --speaker self --scope internal --by "产品所有者"
 *   voice-cli record    --out ref.wav [--seconds 12] [--device "MacBook Air麦克风"]
 *   voice-cli register  --profile zh-xiaozhi --ref ref.wav [--ref-text "逐字稿"] [--speaker-label 小织]
 *   voice-cli speak     --text "..." --profile zh-xiaozhi --out out.wav [--lufs -16]
 *   voice-cli dub       --in film.mp4 --out dubbed.mp4 --profile zh-xiaozhi --text "..."
 *                       [--policy keep-dialogue] [--segments segs.json] [--lufs -14]
 *   voice-cli verify    --in out.wav --expect-text "..." [--min-match 0.6] [--no-strict]
 *   voice-cli verify    --in music.wav --no-speech-expected
 *
 * 退出码：0 成功；2 用法错误；3 工具错误（code 见 VoiceError）。
 * 任何写入都落到新文件；覆盖原片/参考音频一律拒绝。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { VOICE_TOOLS, VoiceError, callTool } from "./core.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        index += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function number(value, fallback = undefined) {
  if (value === undefined || value === true) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function verifyNumber(flags, key) {
  if (flags[key] === undefined) return undefined;
  if (typeof flags[key] !== "string" || !flags[key].trim() || !Number.isFinite(Number(flags[key]))) {
    throw new VoiceError(`--${key} 必须是有限数值`, "bad_request");
  }
  return Number(flags[key]);
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readSegments(flags) {
  if (typeof flags.segments !== "string") return undefined;
  const raw = await fsp.readFile(path.resolve(flags.segments), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new VoiceError("--segments 文件必须是数组：[{start,end,text}]", "bad_request");
  return parsed;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);

  switch (command) {
    case "health":
      print(await callTool("voiceread.health", {}));
      return 0;
    case "devices":
      print(await callTool("voiceread.devices", {}));
      return 0;
    case "voices":
      print(await callTool("voiceread.voices", {}));
      return 0;
    case "probe":
      print(await callTool("voiceread.probe", { input: flags.in }));
      return 0;
    case "consent":
      print(await callTool("voicewrite.consent", {
        profile: flags.profile,
        declared: flags.declared !== "false",
        speaker_type: flags.speaker ?? "self",
        scope: flags.scope ?? "internal",
        declared_by: flags.by ?? null,
        evidence: flags.evidence ?? null,
        expires_at: flags.expires ?? null,
      }));
      return 0;
    case "record":
      print(await callTool("voicewrite.record", {
        out: flags.out,
        seconds: number(flags.seconds, 12),
        device: flags.device,
        noise_db: number(flags.noise),
      }));
      return 0;
    case "register":
      print(await callTool("voicewrite.register", {
        profile: flags.profile,
        reference: flags.ref ?? flags.reference,
        ref_text: typeof flags["ref-text"] === "string" ? flags["ref-text"] : undefined,
        speaker_label: flags["speaker-label"] ?? null,
        engine_voice_id: flags["engine-voice"] ?? null,
        allow_low_quality: flags["allow-low-quality"] === true,
      }));
      return 0;
    case "speak":
      print(await callTool("voicewrite.speak", {
        text: typeof flags.text === "string" ? flags.text : undefined,
        text_file: typeof flags.file === "string" ? flags.file : undefined,
        profile: flags.profile,
        out: flags.out,
        lufs: number(flags.lufs),
        speed: number(flags.speed),
        instruct: typeof flags.instruct === "string" ? flags.instruct : undefined,
        max_chunk_chars: number(flags["max-chars"]),
        gap_ms: number(flags["gap-ms"]),
      }));
      return 0;
    case "dub":
      print(await callTool("voicewrite.dub", {
        video: flags.in,
        out: flags.out,
        profile: flags.profile,
        text: typeof flags.text === "string" ? flags.text : undefined,
        segments: await readSegments(flags),
        policy: flags.policy ?? "keep-dialogue",
        lufs: number(flags.lufs),
        duck_db: number(flags.duck),
        original_gain_db: number(flags["original-gain"]),
        allow_discard_original: flags["allow-discard-original"] === true,
        allow_overflow: flags["allow-overflow"] === true,
      }));
      return 0;
    case "verify":
      print(await callTool("voicewrite.verify", {
        input: flags.in,
        expect_text: typeof flags["expect-text"] === "string" ? flags["expect-text"] : undefined,
        ...(flags["no-speech-expected"] === true ? { speech_expected: false } : {}),
        min_match_ratio: verifyNumber(flags, "min-match"),
        lufs: verifyNumber(flags, "lufs"),
        true_peak: verifyNumber(flags, "true-peak"),
        /**
         * `--no-strict`（2026-09-25）：只做**人声核查**的调用方（如"每句台词都要有人声"的逐镜探测）
         * 要的是 ASR 与活动度**读数**，不应该因为真峰值/响度这类交付项不达标就整条命令失败——
         * 那会让"到底有没有人声"这件事变成不可读（真机：SC-04 因 -0.69dBTP 让核查返回空值）。
         * 交付项本身由配音/配乐/母版环节的复核与门禁把关，不在这里混判。
         */
        ...(flags["no-strict"] === true ? { strict: false } : {}),
      }));
      return 0;
    case "tools":
      print({ tools: VOICE_TOOLS });
      return 0;
    default:
      process.stderr.write(
        `用法：voice-cli <${["health", "devices", "voices", "probe", "consent", "record", "register", "speak", "dub", "verify", "tools"].join("|")}> [options]\n`,
      );
      return 2;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    if (error instanceof VoiceError) {
      process.stderr.write(`[${error.code}] ${error.message}${error.retryable ? "（可重试）" : ""}\n`);
      process.exit(3);
    }
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(3);
  });
