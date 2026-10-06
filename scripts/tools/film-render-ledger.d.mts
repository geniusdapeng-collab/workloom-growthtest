export interface FilmRenderLedgerShot {
  shotId: string;
  attempts: number;
  rejected: number;
  lastReason: string | null;
  platformRejections: number;
  canaryAborts: number;
}
export interface FilmRenderLedger {
  generatedAt: string;
  projectId: string;
  totals: { renderAttempts: number; rendersRejected: number; platformRejections: number; canaryAborts: number; postStageRetries: number };
  shots: FilmRenderLedgerShot[];
  postStages: Array<{ stage: string; retries: number; lastReason: string | null }>;
  acceptedTaskIds: string[];
  unacceptedRenderRecords: number;
  warnings: string[];
  notes: string[];
}
export function isAcceptedFilmTaskId(value: unknown): value is string;
export function buildFilmRenderLedger(history: readonly unknown[], options?: { projectId?: string; generatedAt?: string }): FilmRenderLedger;
