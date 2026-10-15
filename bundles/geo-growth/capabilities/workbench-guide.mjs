/** Fixed repository guide; no caller-selected paths, service or model calls. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const VIDEO_WORKBENCH_GUIDE_PATH = 'docs/ai-video-workbench-guide.md';
export const VIDEO_WORKBENCH_GUIDE_VERSION = '2026-10-15.2';
const REPOSITORY = 'workloom-ai/workloom-growthtest';
const MAX_BYTES = 256 * 1024;

export class VideoWorkbenchGuideError extends Error {
  constructor(code, message) { super(message); this.name = 'VideoWorkbenchGuideError'; this.code = code; }
}

function fixedFile(root, ref) {
  const file = join(root, ref);
  let info, actual;
  try { info = lstatSync(file); actual = realpathSync(file); }
  catch { throw new VideoWorkbenchGuideError('VIDEO_GUIDE_UNAVAILABLE', `缺少或无法读取本仓指南资产：${ref}`); }
  const rel = relative(root, actual);
  if (!info.isFile() || info.isSymbolicLink() || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new VideoWorkbenchGuideError('VIDEO_GUIDE_UNAVAILABLE', `本仓指南资产须为根目录内普通文件：${ref}`);
  }
  if (info.size < 1 || info.size > MAX_BYTES) {
    throw new VideoWorkbenchGuideError('VIDEO_GUIDE_UNAVAILABLE', `本仓指南资产为空或超过读取上限：${ref}`);
  }
  try {
    const bytes = readFileSync(file);
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('invalid size');
    return bytes;
  }
  catch { throw new VideoWorkbenchGuideError('VIDEO_GUIDE_UNAVAILABLE', `无法读取本仓指南资产：${ref}`); }
}

/** Internal root is provided only by the trusted gateway, never by tool input. */
export function readVideoWorkbenchGuideFromRoot(repositoryRoot) {
  let root;
  try { root = realpathSync(resolve(repositoryRoot)); }
  catch { throw new VideoWorkbenchGuideError('VIDEO_GUIDE_UNAVAILABLE', '无法定位本仓指南根目录'); }
  let product;
  try { product = JSON.parse(fixedFile(root, 'product.manifest.json').toString('utf8')); }
  catch (error) {
    if (error instanceof VideoWorkbenchGuideError) throw error;
    throw new VideoWorkbenchGuideError('VIDEO_GUIDE_UNAVAILABLE', '产品身份文件无效，不能读取视频指南');
  }
  if (product.repository !== REPOSITORY || typeof product.productId !== 'string' || !product.productId) {
    throw new VideoWorkbenchGuideError('VIDEO_GUIDE_REPOSITORY_MISMATCH', '产品身份与本仓视频指南不一致');
  }
  const bytes = fixedFile(root, VIDEO_WORKBENCH_GUIDE_PATH);
  let markdown;
  try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new VideoWorkbenchGuideError('VIDEO_GUIDE_UNAVAILABLE', '视频指南不是有效 UTF-8 正文'); }
  if (!markdown.includes(`guideVersion: ${VIDEO_WORKBENCH_GUIDE_VERSION}`) || !markdown.includes(REPOSITORY)) {
    throw new VideoWorkbenchGuideError('VIDEO_GUIDE_UNAVAILABLE', '视频指南缺少当前版本或本仓身份');
  }
  return {
    schemaVersion: 'workloom.video-workbench-guide/v1',
    repository: REPOSITORY, productId: product.productId, guideVersion: VIDEO_WORKBENCH_GUIDE_VERSION,
    path: VIDEO_WORKBENCH_GUIDE_PATH, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    markdown, limitations: ['指南读取不启动生产、不证明身份或授权', '只使用本仓实际已接通的执行入口', '生产完成须核对真实阶段和交付回执'],
  };
}

export function readVideoWorkbenchGuide(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
    throw new VideoWorkbenchGuideError('INVALID_INPUT', '视频工作台指南只接受空对象，不接受路径或覆盖项');
  }
  return readVideoWorkbenchGuideFromRoot(resolve(import.meta.dirname, '..', '..', '..'));
}
