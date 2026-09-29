import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishUhdPackage, registerUhdStagedFile, stageUhdFile } from "./uhd-publication.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-uhd-publication-"));
  dirs.push(root);
  const outDir = join(root, "out", "uhd");
  const postDir = join(root, "post");
  const stagingDir = join(root, "out", ".new.pending");
  const packageDir = join(outDir, "film-delivery-package-new");
  const currentFile = join(outDir, "film-current.json");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(postDir);
  mkdirSync(stagingDir);
  const old = ["film-30s-final.mp4", "film-cover.png", "film-softsub.mp4"];
  for (const name of old) writeFileSync(join(outDir, name), `old:${name}`);
  writeFileSync(currentFile, '{"packageDir":"film-delivery-package-old"}\n');
  const receipts = old.map((name) => {
    const source = join(postDir, name);
    writeFileSync(source, `new:${name}`);
    return stageUhdFile(stagingDir, source, name);
  });
  const subtitle = join(postDir, "film.zh.srt");
  writeFileSync(subtitle, "new subtitles");
  receipts.push(stageUhdFile(stagingDir, subtitle, "subtitles/film.zh.srt"));
  writeFileSync(join(stagingDir, "film-variant-warm.mp4"), "new variant");
  receipts.push(registerUhdStagedFile(stagingDir, "film-variant-warm.mp4"));
  writeFileSync(join(stagingDir, "delivery-manifest.json"), JSON.stringify({
    deliverable: { path: join(packageDir, "film-30s-final.mp4") },
    cover: { path: join(packageDir, "film-cover.png") },
    subtitles: { softsub: join(packageDir, "film-softsub.mp4"), sidecarDir: join(packageDir, "subtitles") },
    variants: [{ path: join(packageDir, "film-variant-warm.mp4") }],
    publicationArtifacts: receipts.map((receipt) => ({ path: join(packageDir, receipt.relativePath), sha256: receipt.sha256 })),
  }));
  receipts.push(registerUhdStagedFile(stagingDir, "delivery-manifest.json"));
  const oldBytes = old.map((name) => readFileSync(join(outDir, name)));
  const oldPointer = readFileSync(currentFile);
  const assertOldUntouched = () => old.forEach((name, index) =>
    expect(readFileSync(join(outDir, name))).toEqual(oldBytes[index]));
  const assertOldPointer = () => expect(readFileSync(currentFile)).toEqual(oldPointer);
  return { outDir, postDir, stagingDir, packageDir, currentFile,
    projectId: "film", runId: "run-new", shotlistSha256: "a".repeat(64),
    receipts, assertOldUntouched, assertOldPointer };
}

describe("UHD 成片按版本包原子发布", () => {
  it("master 或 deliver 拒绝时，旧正式母版、封面、软字幕均不被覆盖", () => {
    for (const rejected of ["master", "deliver"] as const) {
      const state = fixture();
      expect(() => publishUhdPackage({
        ...state, masterApproved: rejected !== "master", deliverApproved: rejected !== "deliver",
      })).toThrow(/双重放行/);
      expect(existsSync(state.packageDir)).toBe(false);
      state.assertOldUntouched();
      state.assertOldPointer();
    }
  });

  it("暂存母版、封面、软字幕或字幕在发布前变化时拒绝，旧正式文件仍完整", () => {
    for (const name of ["film-30s-final.mp4", "film-cover.png", "film-softsub.mp4", "subtitles/film.zh.srt"]) {
      const state = fixture();
      writeFileSync(join(state.stagingDir, name), `tampered:${name}`);
      expect(() => publishUhdPackage({ ...state, masterApproved: true, deliverApproved: true }))
        .toThrow(/摘要变化/);
      expect(existsSync(state.packageDir)).toBe(false);
      state.assertOldUntouched();
      state.assertOldPointer();
    }
  });

  it("清单漏记主封面或软字幕 SHA 时拒绝，旧正式文件仍完整", () => {
    for (const missing of ["film-cover.png", "film-softsub.mp4"]) {
      const state = fixture();
      const file = join(state.stagingDir, "delivery-manifest.json");
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        publicationArtifacts: Array<{ path: string; sha256: string }>;
      };
      manifest.publicationArtifacts = manifest.publicationArtifacts.filter((entry) => !entry.path.endsWith(missing));
      writeFileSync(file, JSON.stringify(manifest));
      state.receipts[state.receipts.length - 1] = registerUhdStagedFile(state.stagingDir, "delivery-manifest.json");
      expect(() => publishUhdPackage({ ...state, masterApproved: true, deliverApproved: true }))
        .toThrow(/清单中的主封面/);
      expect(existsSync(state.packageDir)).toBe(false);
      state.assertOldUntouched();
      state.assertOldPointer();
    }
  });

  it("候选源片变化或版本目录已存在时拒绝，旧正式指针与文件不变", () => {
    const changedSource = fixture();
    writeFileSync(join(changedSource.postDir, "film-cover.png"), "modified after staging");
    expect(() => publishUhdPackage({ ...changedSource, masterApproved: true, deliverApproved: true }))
      .toThrow(/摘要变化/);
    changedSource.assertOldUntouched();
    changedSource.assertOldPointer();

    const collision = fixture();
    mkdirSync(collision.packageDir);
    writeFileSync(join(collision.packageDir, "film-cover.png"), "existing generation");
    expect(() => publishUhdPackage({ ...collision, masterApproved: true, deliverApproved: true }))
      .toThrow(/正式版本已存在/);
    expect(readFileSync(join(collision.packageDir, "film-cover.png"), "utf8")).toBe("existing generation");
    collision.assertOldUntouched();
    collision.assertOldPointer();
  });

  it("双门放行后只发布新版本包，清单路径与所有文件同包，旧正式文件保持原字节", () => {
    const state = fixture();
    const published = publishUhdPackage({ ...state, masterApproved: true, deliverApproved: true });
    expect(existsSync(state.stagingDir)).toBe(false);
    const manifest = JSON.parse(readFileSync(join(state.packageDir, "delivery-manifest.json"), "utf8")) as {
      deliverable: { path: string }; cover: { path: string };
      subtitles: { softsub: string; sidecarDir: string }; variants: Array<{ path: string }>;
    };
    for (const file of [manifest.deliverable.path, manifest.cover.path, manifest.subtitles.softsub,
      join(manifest.subtitles.sidecarDir, "film.zh.srt"), manifest.variants[0]!.path]) {
      expect(file.startsWith(state.packageDir + "/")).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
    const current = JSON.parse(readFileSync(state.currentFile, "utf8")) as {
      packageDir: string; manifest: { path: string; sha256: string };
    };
    expect(current.packageDir).toBe("film-delivery-package-new");
    expect(current.manifest.path).toBe("film-delivery-package-new/delivery-manifest.json");
    expect(current.manifest.sha256).toBe(published.manifestSha256);
    state.assertOldUntouched();
  });
});
