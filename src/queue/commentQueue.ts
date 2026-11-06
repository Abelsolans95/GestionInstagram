import type { DB } from '../db/index.js';
import { insertCommentIfNew, type CommentRow } from '../db/comments.js';
import type { CommentEvent } from '../webhook/parse.js';

/**
 * Cola persistente sobre la tabla `comments`.
 *  - Encolar = INSERT OR IGNORE con status 'queued'. Si el comment_id ya existe (duplicado de Meta,
 *    comentario importado, ya respondido...) no se hace nada.
 *  - El worker reclama el siguiente 'queued' pasándolo a 'processing'.
 *  - Sobrevive a reinicios: lo que quedó en 'processing' vuelve a 'queued' al arrancar.
 */

export interface EnqueueResult {
  inserted: string[];
  duplicates: string[];
}

export interface CommentQueue {
  enqueueWebhookEvents(events: CommentEvent[], receivedAt: Date, rawBody?: Buffer): EnqueueResult;
  claimNext(): CommentRow | undefined;
  recoverStale(): number;
  /** Se llama cuando entra trabajo nuevo, para despertar al worker sin esperar al polling. */
  onEnqueued(listener: () => void): void;
}

export function createCommentQueue(db: DB, now: () => number = Date.now): CommentQueue {
  const listeners: Array<() => void> = [];

  const insertEvent = db.prepare(
    'INSERT INTO webhook_events (received_at, body, comment_ids) VALUES (?, ?, ?)',
  );

  const enqueueTx = db.transaction(
    (events: CommentEvent[], receivedAt: number, rawBody?: Buffer): EnqueueResult => {
      const result: EnqueueResult = { inserted: [], duplicates: [] };
      if (rawBody) {
        insertEvent.run(
          receivedAt,
          rawBody.toString('utf8'),
          JSON.stringify(events.map((e) => e.commentId)),
        );
      }
      for (const e of events) {
        const isNew = insertCommentIfNew(
          db,
          {
            commentId: e.commentId,
            mediaId: e.mediaId,
            parentId: e.parentId,
            // Si el payload trae parent_id es una respuesta confirmada; si no, el worker lo comprobará.
            parentChecked: e.parentId !== null,
            igUserId: e.fromId,
            username: e.fromUsername,
            text: e.text,
            commentedAt: receivedAt,
            source: 'webhook',
            status: 'queued',
          },
          receivedAt,
        );
        (isNew ? result.inserted : result.duplicates).push(e.commentId);
      }
      return result;
    },
  );

  const claim = db.prepare(
    `UPDATE comments
        SET status = 'processing', attempts = attempts + 1, updated_at = @now
      WHERE comment_id = (
        SELECT comment_id FROM comments WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1)
      RETURNING *`,
  );

  return {
    enqueueWebhookEvents(events, receivedAt, rawBody) {
      const result = enqueueTx(events, receivedAt.getTime(), rawBody);
      if (result.inserted.length > 0) for (const l of listeners) l();
      return result;
    },
    claimNext() {
      return claim.get({ now: now() }) as CommentRow | undefined;
    },
    recoverStale() {
      return db
        .prepare(
          `UPDATE comments SET status = 'queued', updated_at = ? WHERE status = 'processing'`,
        )
        .run(now()).changes;
    },
    onEnqueued(listener) {
      listeners.push(listener);
    },
  };
}

/** Borra eventos crudos antiguos (se guardan solo para depurar la forma del payload). */
export function pruneWebhookEvents(db: DB, olderThanMs: number, now = Date.now()): number {
  return db.prepare('DELETE FROM webhook_events WHERE received_at < ?').run(now - olderThanMs)
    .changes;
}
