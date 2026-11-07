/**
 * Modo revisión (REVIEW_MODE=true): las respuestas generadas quedan en 'pending_review'.
 * Desde aquí se listan, editan, aprueban (pasan a 'scheduled' con el delay aleatorio y las
 * publica el publicador respetando el tope por hora) o rechazan.
 */
import { getComment, updateComment, type CommentRow } from '../db/comments.js';
import type { DB } from '../db/index.js';
import { MAX_REPLY_CHARS, normalizeReplyText } from '../llm/reply.js';
import { randomDelayMs, type ReplySettings } from '../pipeline/replyStep.js';

export interface PendingReply extends CommentRow {
  question: string | null;
  permalink: string | null;
}

export function listPending(db: DB, limit = 200): PendingReply[] {
  return db
    .prepare(
      `SELECT c.*, m.question, m.permalink FROM comments c LEFT JOIN media m ON m.media_id = c.media_id
       WHERE c.status = 'pending_review' ORDER BY c.created_at LIMIT ?`,
    )
    .all(limit) as PendingReply[];
}

export class ReviewError extends Error {}

function pending(db: DB, id: string): CommentRow {
  const row = getComment(db, id);
  if (!row) throw new ReviewError(`No existe el comentario ${id}`);
  if (row.status !== 'pending_review') throw new ReviewError(`El comentario ${id} no está pendiente de revisión (status: ${row.status})`);
  return row;
}

/** Cambia el texto de la respuesta (se valida igual que la del modelo). */
export function editReply(db: DB, id: string, text: string, now = Date.now()): string {
  const row = pending(db, id);
  const n = normalizeReplyText(text, row.username ?? '');
  if (!n.text) throw new ReviewError('La respuesta está vacía');
  if (n.error === 'too_long') throw new ReviewError(`La respuesta supera ${MAX_REPLY_CHARS} caracteres`);
  if (n.error === 'contains_link') throw new ReviewError('La respuesta no puede llevar enlaces');
  updateComment(db, id, { reply_text: n.text, reason: 'editada en revisión' }, now);
  return n.text;
}

/** Aprueba: pasa a 'scheduled' con el delay aleatorio. Si se indica texto, lo edita antes. */
export function approve(
  db: DB,
  id: string,
  settings: Pick<ReplySettings, 'delayMinSec' | 'delayMaxSec'>,
  opts: { text?: string; now?: number; random?: () => number } = {},
): CommentRow {
  const now = opts.now ?? Date.now();
  if (opts.text !== undefined) {
    const current = pending(db, id);
    if (opts.text.trim() !== (current.reply_text ?? '').trim()) editReply(db, id, opts.text, now);
  }
  const row = pending(db, id);
  if (!row.reply_text) throw new ReviewError('No hay texto de respuesta');
  updateComment(db, id, { status: 'scheduled', publish_at: now + randomDelayMs(settings, opts.random), decision: 'reply', reason: 'aprobada en revisión' }, now);
  return getComment(db, id)!;
}

export function reject(db: DB, id: string, now = Date.now()): void {
  pending(db, id);
  updateComment(db, id, { status: 'rejected', decision: 'rejected', reason: 'rechazada en revisión' }, now);
}

/** Vuelve a encolar un comentario fallido (nunca uno importado). */
export function retryFailed(db: DB, id: string, now = Date.now()): void {
  const row = getComment(db, id);
  if (!row) throw new ReviewError(`No existe el comentario ${id}`);
  if (row.status !== 'failed') throw new ReviewError(`El comentario ${id} no está en failed (status: ${row.status})`);
  if (row.source === 'import') throw new ReviewError('Los comentarios importados no se responden');
  updateComment(db, id, { status: 'queued', attempts: 0, last_error: null }, now);
}

/** Comentarios fallidos que se pueden reintentar (de webhook o polling; nunca importados). */
export function countRetryableFailed(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'failed' AND source != 'import'").get() as { n: number }).n;
}

/** Vuelve a encolar todos los fallidos (p. ej. tras arreglar una clave). Devuelve cuántos. */
export function retryAllFailed(db: DB, now = Date.now()): number {
  return db
    .prepare(
      `UPDATE comments SET status = 'queued', attempts = 0, publish_attempts = 0, last_error = NULL, updated_at = ?
       WHERE status = 'failed' AND source != 'import'`,
    )
    .run(now).changes;
}

/** Comentarios fallidos (los que reintenta el botón), con el motivo. */
export function listRetryableFailed(db: DB, limit = 50): CommentRow[] {
  return db
    .prepare("SELECT * FROM comments WHERE status = 'failed' AND source != 'import' ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as CommentRow[];
}
