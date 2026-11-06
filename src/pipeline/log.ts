import type { Logger } from '../logger.js';

/** Línea de log estructurada, una por comentario procesado (webhook, import o poll). */
export interface CommentLogLine {
  comment_id: string;
  username: string | null;
  origin: 'webhook' | 'import' | 'poll';
  decision: string;
  reason?: string | null | undefined;
  label?: string | null | undefined;
  latency_ms: number;
  error?: string | null | undefined;
  [extra: string]: unknown;
}

export function logCommentOutcome(logger: Logger, line: CommentLogLine): void {
  const level = line.error ? 'error' : 'info';
  logger[level]({ event: 'comment_processed', ...line }, `comentario ${line.decision}`);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
