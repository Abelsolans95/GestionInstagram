import type { DB } from './index.js';

export type CommentStatus =
  | 'queued' // esperando al worker
  | 'processing' // el worker lo está procesando
  | 'skipped' // no se responde (filtros, el modelo devolvió null, ...)
  | 'pending_review' // respuesta generada, esperando aprobación (REVIEW_MODE)
  | 'scheduled' // respuesta lista, se publicará a partir de publish_at
  | 'publishing' // el publicador la está enviando a Meta
  | 'replied' // respuesta publicada
  | 'rejected' // rechazada en revisión
  | 'failed' // falló 3 veces
  | 'imported'; // importado por el script de importación: NUNCA se responde

export type CommentSource = 'webhook' | 'import' | 'poll';

export interface CommentRow {
  comment_id: string;
  media_id: string;
  parent_id: string | null;
  parent_checked: number;
  thread_id: string | null;
  ig_user_id: string | null;
  username: string | null;
  text: string;
  commented_at: number;
  source: CommentSource;
  status: CommentStatus;
  decision: string | null;
  reason: string | null;
  attempts: number;
  last_error: string | null;
  extract_status: 'done' | 'skipped' | 'failed' | null;
  extracted_at: number | null;
  answers_question: number | null;
  answer: string | null;
  answer_label: string | null;
  character_name: string | null;
  reply_text: string | null;
  reply_reason: string | null;
  reply_target_id: string | null;
  publish_at: number | null;
  replied_at: number | null;
  reply_comment_id: string | null;
  publish_attempts: number;
  /** 'complaint' = respuesta a una queja de que no sale (solo una por persona). */
  reply_kind: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewComment {
  commentId: string;
  mediaId: string;
  parentId: string | null;
  parentChecked: boolean;
  igUserId: string | null;
  username: string | null;
  text: string;
  commentedAt: number;
  source: CommentSource;
  status: Extract<CommentStatus, 'queued' | 'imported'>;
}

/**
 * Inserta el comentario si no existe. Devuelve false si ya estaba (duplicado): la clave primaria
 * comment_id es la que garantiza la idempotencia frente a reenvíos de Meta.
 */
export function insertCommentIfNew(db: DB, c: NewComment, now = Date.now()): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO comments (
         comment_id, media_id, parent_id, parent_checked, thread_id, ig_user_id, username, text,
         commented_at, source, status, created_at, updated_at)
       VALUES (@commentId, @mediaId, @parentId, @parentChecked, @threadId, @igUserId, @username,
         @text, @commentedAt, @source, @status, @now, @now)`,
    )
    .run({
      ...c,
      // Los usernames de Instagram no distinguen mayúsculas: se guardan en minúscula.
      username: c.username ? c.username.toLowerCase() : null,
      parentChecked: c.parentChecked ? 1 : 0,
      threadId: c.parentId ?? (c.parentChecked ? c.commentId : null),
      now,
    });
  return res.changes === 1;
}

export function getComment(db: DB, commentId: string): CommentRow | undefined {
  return db.prepare('SELECT * FROM comments WHERE comment_id = ?').get(commentId) as
    | CommentRow
    | undefined;
}

type Patch = Partial<Omit<CommentRow, 'comment_id' | 'created_at'>>;

/** Actualiza columnas de un comentario (y updated_at). */
export function updateComment(db: DB, commentId: string, patch: Patch, now = Date.now()): void {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  const sets = [...keys.map((k) => `${k} = @${k}`), 'updated_at = @__now'].join(', ');
  db.prepare(`UPDATE comments SET ${sets} WHERE comment_id = @__id`).run({
    ...patch,
    __now: now,
    __id: commentId,
  });
}

/**
 * Tus últimas respuestas en un vídeo, de la más reciente a la más antigua: las generadas (pendientes,
 * programadas o publicadas) y las que escribiste a mano en un hilo. Se pasan al modelo para que no
 * se repita. Las automáticas ya publicadas no salen dos veces (se excluye su comentario propio).
 */
export function recentRepliesInMedia(db: DB, mediaId: string, excludeCommentId: string, limit = 12): string[] {
  const rows = db
    .prepare(
      `SELECT t FROM (
         SELECT reply_text AS t, COALESCE(replied_at, updated_at) AS at FROM comments
          WHERE media_id = @mediaId AND comment_id != @exclude AND reply_text IS NOT NULL
            AND status IN ('pending_review', 'scheduled', 'publishing', 'replied')
         UNION ALL
         SELECT text AS t, commented_at AS at FROM comments
          WHERE media_id = @mediaId AND decision = 'own_comment' AND parent_id IS NOT NULL AND text != ''
            AND comment_id NOT IN (SELECT reply_comment_id FROM comments WHERE reply_comment_id IS NOT NULL)
       ) ORDER BY at DESC LIMIT @limit`,
    )
    .all({ mediaId, exclude: excludeCommentId, limit }) as { t: string }[];
  return rows.map((r) => r.t);
}

export function countByStatus(db: DB): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM comments GROUP BY status').all() as {
    status: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
