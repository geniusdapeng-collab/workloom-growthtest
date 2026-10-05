export interface FilmRenderTaskOptions {
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  journalFile: string;
  resumeTaskId?: string;
  expected: { model: string; duration: number; resolution: string; ratio: string };
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Called only before creating a new paid submission, never for a read-only recovery. */
  beforeSubmit?: () => void | Promise<void>;
}
export function readResumeTasks(file: string, knownShotIds: readonly string[]): Record<string, string>;
export function verifyTaskResult(task: unknown, expected: FilmRenderTaskOptions['expected'], taskId: string): void;
export function runFilmRenderTask(options: FilmRenderTaskOptions): Promise<{
  taskId: string; url: string; lastFrame: string | null; resumed: boolean; requestInputVerified: boolean;
}>;
