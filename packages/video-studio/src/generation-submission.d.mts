export class GenerationSubmissionError extends Error {
  acceptance: "unknown" | "rejected";
  called: boolean;
  constructor(code: string, acceptance?: "unknown" | "rejected", options?: { cause?: unknown; called?: boolean });
}
export function isDefiniteGenerationRejection(status: number, text: string): boolean;
export function generationRequestHash(endpoint: string, body: string): string;
export function readGenerationSubmissionState(file: string): { state: "submission-unknown" | "accepted" | "rejected"; requestHash: string; endpoint: string } | null;
export function submitGenerationOnce(options: {
  endpoint: string;
  body: string;
  journalFile: string;
  headers?: HeadersInit;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  beforeSubmit?: () => void | Promise<void>;
}): Promise<{ response: Response; acceptance: "accepted" | "rejected"; resumed: boolean; called: boolean; requestHash: string }>;
