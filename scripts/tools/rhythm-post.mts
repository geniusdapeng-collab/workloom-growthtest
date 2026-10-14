/** Local sound-design entry point used by post-bridge; requested synthetic cues only. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeRhythmSound } from "./rhythm-edit.mts";
import type { RhythmPlanInput } from "../../packages/video-studio/src/rhythm-plan.js";
const requestPath = process.argv[2];
if (!requestPath) throw new Error("RHYTHM_POST_REQUEST_REQUIRED");
const request = JSON.parse(readFileSync(resolve(requestPath), "utf8")) as {
  plan: RhythmPlanInput; file: string; outputDir: string; ffmpeg: string; ffprobe: string; resultFile: string;
};
const result = await executeRhythmSound(request);
writeFileSync(request.resultFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
