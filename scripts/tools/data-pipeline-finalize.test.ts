import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

function runFinalizer(resultPath: string): {
  status: number | null;
  qualification: Record<string, unknown>;
} {
  const outDir = mkdtempSync(join(tmpdir(), "workloom-finalize-"));
  temporaryDirectories.push(outDir);
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/tools/data-pipeline-finalize.mts",
      "--result",
      resultPath,
      "--out",
      outDir,
      "--no-dialogue",
      "--aspect",
      "9:16",
      "--resolution",
      "1080x1920",
      "--fps",
      "30",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    },
  );
  const qualification = JSON.parse(
    readFileSync(join(outDir, "qualification.json"), "utf8"),
  ) as Record<string, unknown>;
  return { status: run.status, qualification };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("真实预生产结果的最终化资格", () => {
  it.each([
    {
      label: "营销 m3",
      resultPath: "outputs/ai-video-stress/T-2026-1031-9004/canary-m3/result.json",
      expectedCode: "PORTRAIT_STAGE_SKIPPED",
    },
    {
      label: "叙事 n21",
      resultPath: "outputs/ai-video-stress/T-2026-1031-9004/canary-n21/result.json",
      expectedCode: "PORTRAIT_BINDING_REQUIRED",
    },
  ])("$label 的未绑定人物必须阻断 G8 资格", ({ resultPath, expectedCode }) => {
    const { status, qualification } = runFinalizer(resultPath);
    expect(status).toBe(4);
    expect(qualification.status).toBe("blocked");
    expect(qualification.providerSubmission).toBe(false);
    expect(qualification.renderSubmitted).toBe(false);
    const characterQualification = qualification.characterQualification as {
      pass: boolean;
      issues: Array<{ code: string }>;
    };
    expect(characterQualification.pass).toBe(false);
    const codes = characterQualification.issues.map((issue) => issue.code);
    expect(codes.some((code) => code === expectedCode), `${expectedCode}: ${codes.join(",")}`).toBe(true);
  });
});
