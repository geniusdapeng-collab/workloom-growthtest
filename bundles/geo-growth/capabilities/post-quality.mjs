/** Current-media acceptance for external agents. Read-only, bounded, and never invokes a paid model. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
const inside = (root, file) => { const rel = relative(root, file); return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
class QualityCapabilityError extends Error {
  constructor(message, code = "BAD_REQUEST") { super(message); this.name = "QualityCapabilityError"; this.code = code; }
}
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const artifactRoot = () => resolve(String(process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT ?? "").trim() || resolve(import.meta.dirname, "../../.."));
function bounded(file, root, label) {
  const target = resolve(root, file);
  if (!inside(root, target)) throw new QualityCapabilityError(`${label} 越出产物根`);
  if (existsSync(target) && !inside(realpathSync(root), realpathSync(target))) throw new QualityCapabilityError(`${label} 符号链接越出产物根`);
  return target;
}
function textFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new QualityCapabilityError("清单须为普通文件");
  if (stat.size > MAX_BYTES) throw new QualityCapabilityError("清单超过 8 MiB 读取上限", "TOO_LARGE");
  return readFileSync(file, "utf8");
}
function parse(file) { try { return JSON.parse(textFile(file)); } catch (error) {
  if (error instanceof QualityCapabilityError) throw error;
  throw new QualityCapabilityError(`清单不是合法 JSON：${error.message}`);
} }
const hashText = (value) => createHash("sha256").update(value).digest("hex");
function hashFile(file) {
  const handle = openSync(file, "r");
  try { const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024); let bytes;
    while ((bytes = readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally { closeSync(handle); }
}
function optionalText(value, label, limit) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\0\r\n]/u.test(value)) throw new QualityCapabilityError(`${label} 须为有效非空字符串`);
  return value.trim();
}

export async function deliveryQuality(input = {}) {
  if (!plain(input) || Object.keys(input).some((key) => !["projectId", "outDir", "kind"].includes(key))) throw new QualityCapabilityError("输入对象含不支持字段");
  const projectId = optionalText(input.projectId, "projectId", 200);
  const outDir = optionalText(input.outDir, "outDir", 400) ?? "work/out";
  const kind = input.kind ?? "auto";
  if (!["auto", "post", "generation"].includes(kind)) throw new QualityCapabilityError("kind 只允许 auto / post / generation");
  if (isAbsolute(outDir) || /^[A-Za-z]:[\\/]/u.test(outDir)) throw new QualityCapabilityError("outDir 只接受产物根内相对路径");
  const root = artifactRoot();
  const folder = bounded(outDir, root, "outDir");
  if (!existsSync(folder)) return { found: false, projectId: projectId ?? null, complete: false, technicalQuality: "unverified", paidCalls: 0 };
  if (!lstatSync(folder).isDirectory()) throw new QualityCapabilityError("outDir 须为目录");
  const candidates = [];
  let pointer = null;
  const pointerFile = join(folder, "current.json");
  const postFile = join(folder, "delivery-manifest.json");
  if (kind !== "generation" && existsSync(postFile)) candidates.push({ kind: "post", file: bounded(postFile, root, "manifest") });
  if (kind !== "post") {
    if (existsSync(pointerFile)) {
      const doc = parse(pointerFile);
      if (doc.schemaVersion !== "workloom.uhd-release/v1" || typeof doc.releaseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(doc.releaseId)
          || doc.releaseId.includes("..") || typeof doc.manifest !== "string" || !/^[a-f0-9]{64}$/.test(doc.manifestSha256)) throw new QualityCapabilityError("发布指针格式非法");
      const release = bounded(join(folder, "releases", doc.releaseId), root, "release");
      const file = bounded(doc.manifest, root, "current.manifest");
      if (dirname(file) !== release || resolve(doc.releaseDir ?? "") !== release || hashFile(file) !== doc.manifestSha256) throw new QualityCapabilityError("发布指针与当前清单不一致", "CONFLICT");
      pointer = { file: pointerFile, sha256: hashFile(pointerFile) };
      candidates.push({ kind: "generation", file });
    } else {
      const files = readdirSync(folder);
      if (files.length > 1000) throw new QualityCapabilityError("交付目录超过 1000 个条目", "TOO_LARGE");
      for (const file of files.filter((name) => name.endsWith("-delivery-manifest.json") && (!projectId || name === `${projectId}-delivery-manifest.json`))) {
        candidates.push({ kind: "generation", file: bounded(join(folder, file), root, "manifest") });
      }
    }
  }
  if (!candidates.length) return { found: false, projectId: projectId ?? null, technicalQuality: "unverified", complete: false, paidCalls: 0,
    hint: "没有当前交付清单，不能报告完整交付" };
  if (candidates.length !== 1) throw new QualityCapabilityError("存在多个交付清单，请明确 kind 和 projectId");
  const selected = candidates[0];
  const raw = textFile(selected.file), manifestSha256 = hashText(raw);
  let manifest; try { manifest = JSON.parse(raw); } catch { throw new QualityCapabilityError("交付清单不是合法 JSON"); }
  if (!plain(manifest) || typeof manifest.projectId !== "string" || projectId && manifest.projectId !== projectId) throw new QualityCapabilityError("交付清单项目标识不符");
  const { resolveBinaries } = await import("../../ai-video/connectors/post-bridge/core.mjs");
  let report;
  if (selected.kind === "post") {
    if (manifest.schemaVersion === "workloom.delivery-package/v2") {
      const { inspectDirectorDeliveryManifest, resolveDirectorDeliveryRoot } = await import("../../ai-video/connectors/post-bridge/director-quality.mjs");
      const resolved = await resolveDirectorDeliveryRoot({ root: dirname(selected.file), manifest });
      bounded(resolved.base, root, "导演交付根");
      report = await inspectDirectorDeliveryManifest({ root: dirname(selected.file), manifest, bins: resolveBinaries(), phase: "external-read" });
    } else {
      if (manifest.schemaVersion !== "workloom.delivery-package/v1") throw new QualityCapabilityError("后期交付清单 schema 不支持");
      const { inspectDeliveryManifest, resolveDeliveryRoot } = await import("../../ai-video/connectors/post-bridge/quality-gate.mjs");
      const qualityRoot = await resolveDeliveryRoot({ manifestDir: dirname(selected.file), manifest, allowedRoots: [root] });
      report = await inspectDeliveryManifest({ root: qualityRoot, manifest, bins: resolveBinaries(), phase: "external-read" });
    }
  } else {
    const { inspectGenerationManifest } = await import("../../../scripts/tools/generation-quality.mjs");
    report = await inspectGenerationManifest({ root: dirname(selected.file), manifest, bins: resolveBinaries(), phase: "external-read" });
  }
  if (hashFile(selected.file) !== manifestSha256 || pointer && hashFile(pointer.file) !== pointer.sha256) throw new QualityCapabilityError("验收期间交付版本变化，请读取当前版本重试", "CONFLICT");
  return { found: true, projectId: manifest.projectId, manifestPath: relative(root, selected.file), manifestSha256,
    inspectionKind: selected.kind, technicalQuality: report.passed === true ? "passed" : "failed", complete: report.passed === true,
    artisticQuality: "unverified", paidCalls: 0, report,
    note: "依据当前媒体、原生画幅、处理凭证与完整解码的技术判定；艺术质量须由质检岗位观影复核" };
}
