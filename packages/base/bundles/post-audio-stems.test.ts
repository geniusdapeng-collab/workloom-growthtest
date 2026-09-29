/** Run native cryptographic/media contracts in the normal base CI test command. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bins = [process.env.WORKLOOM_POST_FFMPEG_PATH || "ffmpeg", process.env.WORKLOOM_POST_FFPROBE_PATH || "ffprobe"];
const hasMediaTools = bins.every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
function native(files: string[]) {
  const run = spawnSync(process.execPath, ["--test", ...files.map((file) => resolve(root, file))], {
    cwd: root, env: process.env, encoding: "utf8", timeout: 180000, maxBuffer: 8 << 20,
  });
  expect(run.error, run.error?.message).toBeUndefined();
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toMatch(/(?:#|ℹ) fail 0/);
  expect(run.stdout).toMatch(/(?:#|ℹ) skipped 0/);
}
it("validates real receipt signatures, binding mutations, host tenant and expiry without media tools", () => {
  native(["bundles/ai-video/connectors/post-bridge/audio-stems-trust.test.mjs"]);
}, 30000);
it.skipIf(!hasMediaTools)("renders and replays independent stems; exercises the real mixer, CLI and HTTP idempotency", () => {
  native(["bundles/ai-video/connectors/post-bridge/audio-stems.test.mjs", "bundles/ai-video/connectors/bgm-bridge/audio-stems-mix.test.mjs"]);
}, 180000);
