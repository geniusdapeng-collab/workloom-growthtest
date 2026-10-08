import type { CoverFirstFrameReceipt } from '../../packages/video-studio/src/cover-assembly.js';
export function resolveOpeningTitle(input?: { explicitTitle?: string; disabled?: boolean }): { burn: boolean; title: string; source: 'explicit-opening-title' | 'none' };
export function assertCoverPublication(input: { required?: boolean; preserveSourceFramesRequired?: boolean; receipt?: CoverFirstFrameReceipt | null; inputSha256?: string; coverSha256?: string; outputSha256?: string }): true;
