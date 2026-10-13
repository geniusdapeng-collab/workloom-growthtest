export const GENERATION_QUALITY_SCHEMA: 'workloom.generation-quality/v1';
export interface GenerationBins { ffmpeg: string; ffprobe: string }
export interface GenerationCheck { kind: string; hard: boolean; ok: boolean; detail?: unknown }
export interface GenerationQualityReport {
  schemaVersion: string; phase: string; passed: boolean; checks: GenerationCheck[];
  assets: Array<{ id: string; path: string; sha256: string; media: string; decoded: boolean; passed: boolean }>;
  artisticQualityReviewed: false; paidCalls: 0; [key: string]: unknown;
  generationQuality: { schemaVersion: 'workloom.generation-quality/v1'; scope: 'master' | 'delivery'; sourceCount: number;
    processingCount: number; requestedVariants: string[]; currentFileInspection: true; manifestSha256: string };
}
export class GenerationQualityError extends Error {
  readonly code: 'generation_quality_failed'; readonly retryable: false;
  report: GenerationQualityReport | null;
  constructor(message: string, report?: GenerationQualityReport | null);
}
export function generationFileSha256(file: string): string;
export interface GenerationToken { token: string; stage: string; id: string; [key: string]: unknown }
export interface GenerationOutput { path: string; sha256?: string; media?: string; [key: string]: unknown }
export interface GenerationProof { path: string; sha256: string; stage: string; id: string; outputs: GenerationOutput[] }
export interface GenerationInspection {
  phase: string; scope?: 'master' | 'delivery'; artifacts: Array<Record<string, unknown>>;
  requirements: Array<Record<string, unknown>>; resolution: [number, number]; sourceResolution: [number, number];
  variantIds?: string[]; requiredOutputIds?: string[]; minimumVariantCount?: number;
  allowDownscale?: boolean; allowReframe?: boolean; reframeReason?: string | null;
  audioQuality?: { mode: 'report' | 'block'; targetLufs: number; toleranceLu: number; maxTruePeakDbtp: number } | null;
}
export interface GenerationAccepted {
  manifest: Record<string, unknown>; report: GenerationQualityReport;
  qualityFile: { path: string; sha256: string; passed: boolean }; files: string[];
}
export interface GenerationLifecycle {
  begin(stage: string, id: string, files: string[], parameters?: Record<string, unknown>): GenerationToken | null;
  finish(token: GenerationToken | null, input: { outputs?: Array<string | GenerationOutput>; execution?: Record<string, unknown>;
    parameters?: Record<string, unknown>; beforeInputs?: Array<{path: string; sha256: string}> }): unknown;
  abort(token: GenerationToken | null): void;
  beginStage(name: string, files: string[], parameters?: Record<string, unknown>): GenerationToken | null;
  recordStage(record: { stage: string; invoked: boolean; cached?: boolean; ok: boolean; degraded?: boolean; artifact: string | null; evidence?: Record<string, unknown> }): unknown;
  beginCli(cli: string, args: string[]): GenerationToken | null;
  finishCli(token: GenerationToken | null, input?: { report?: unknown; outputs?: string[]; receiptFile?: string | null }): unknown;
  preserveSource(file: string, id: string): { id: string; path: string; sha256: string; origin: string } | null;
  flush(): Promise<GenerationProof[]>;
  artifact(id: string, file: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  inspect(input: GenerationInspection): Promise<GenerationAccepted>;
  ownsOutput(file: string): boolean;
}
export function createGenerationQuality(input: { root: string; bins?: GenerationBins; enabled?: boolean }): GenerationLifecycle;
export function listGenerationQualityFiles(root: string): string[];
export function inspectGenerationManifest(input: { root: string; manifest: Record<string, unknown>; bins?: GenerationBins; phase?: string }): Promise<GenerationQualityReport>;
