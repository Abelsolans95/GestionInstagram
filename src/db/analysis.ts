import type { DB } from './index.js';

export type QuestionSource = 'caption' | 'manual' | 'none';

export interface MediaRow {
  media_id: string;
  shortcode: string | null;
  permalink: string | null;
  caption: string | null;
  media_type: string | null;
  posted_at: number | null;
  owner_id: string | null;
  owner_username: string | null;
  is_own: number | null;
  question: string | null;
  question_source: QuestionSource | null;
  question_updated_at: number | null;
  fetched_at: number;
  updated_at: number;
}

export interface MediaUpsert {
  mediaId: string;
  shortcode: string | null;
  permalink: string | null;
  caption: string | null;
  mediaType: string | null;
  postedAt: number | null;
  ownerId: string | null;
  ownerUsername: string | null;
  isOwn: boolean | null;
}

// ---------- media ----------

export function getMedia(db: DB, mediaId: string): MediaRow | undefined {
  return db.prepare('SELECT * FROM media WHERE media_id = ?').get(mediaId) as MediaRow | undefined;
}

export function getMediaByShortcode(db: DB, shortcode: string): MediaRow | undefined {
  return db.prepare('SELECT * FROM media WHERE shortcode = ?').get(shortcode) as
    | MediaRow
    | undefined;
}

export function listMediaRows(db: DB): MediaRow[] {
  return db
    .prepare('SELECT * FROM media WHERE is_own IS NOT 0 ORDER BY COALESCE(posted_at, fetched_at) DESC')
    .all() as MediaRow[];
}

/** Inserta o actualiza los datos del vídeo. Nunca toca la pregunta. */
export function upsertMedia(db: DB, m: MediaUpsert, now = Date.now()): void {
  db.prepare(
    `INSERT INTO media (media_id, shortcode, permalink, caption, media_type, posted_at, owner_id,
       owner_username, is_own, fetched_at, updated_at)
     VALUES (@mediaId, @shortcode, @permalink, @caption, @mediaType, @postedAt, @ownerId,
       @ownerUsername, @isOwn, @now, @now)
     ON CONFLICT (media_id) DO UPDATE SET
       shortcode = COALESCE(excluded.shortcode, shortcode),
       permalink = COALESCE(excluded.permalink, permalink),
       caption = COALESCE(excluded.caption, caption),
       media_type = COALESCE(excluded.media_type, media_type),
       posted_at = COALESCE(excluded.posted_at, posted_at),
       owner_id = COALESCE(excluded.owner_id, owner_id),
       owner_username = COALESCE(excluded.owner_username, owner_username),
       is_own = COALESCE(excluded.is_own, is_own),
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`,
  ).run({ ...m, isOwn: m.isOwn === null ? null : m.isOwn ? 1 : 0, now });
}

export function setQuestion(
  db: DB,
  mediaId: string,
  question: string | null,
  source: QuestionSource,
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE media SET question = ?, question_source = ?, question_updated_at = ?, updated_at = ?
     WHERE media_id = ?`,
  ).run(question, source, now, now, mediaId);
}

// ---------- answers ----------

export interface AnswerInsert {
  mediaId: string;
  question: string | null;
  username: string;
  answer: string | null;
  answerLabel: string | null;
  commentId: string;
  rawText: string;
  createdAt: number;
}

/** Etiquetas ya usadas en un vídeo (se pasan al modelo para que las reutilice). */
export function labelsForMedia(db: DB, mediaId: string): string[] {
  return (
    db
      .prepare(
        `SELECT answer_label, COUNT(*) AS n FROM answers
         WHERE media_id = ? AND answer_label IS NOT NULL
         GROUP BY answer_label ORDER BY n DESC, answer_label`,
      )
      .all(mediaId) as { answer_label: string }[]
  ).map((r) => r.answer_label);
}

/**
 * Guarda (o sustituye) la respuesta de un comentario y recalcula cuál es la que cuenta para ese
 * usuario en ese vídeo: vale la última (por fecha del comentario) y se marca cuántas hubo.
 */
export function saveAnswer(db: DB, a: AnswerInsert): void {
  db.transaction(() => {
    db.prepare('DELETE FROM answers WHERE comment_id = ?').run(a.commentId);
    db.prepare(
      `INSERT INTO answers (media_id, question, username, answer, answer_label, comment_id,
         raw_text, created_at)
       VALUES (@mediaId, @question, @username, @answer, @answerLabel, @commentId, @rawText, @createdAt)`,
    ).run(a);
    recomputeLatest(db, a.mediaId, a.username);
  })();
}

/** Quita la respuesta de un comentario (p. ej. al re-extraer y ver que ya no responde). */
export function deleteAnswer(db: DB, commentId: string): void {
  const row = db.prepare('SELECT media_id, username FROM answers WHERE comment_id = ?').get(
    commentId,
  ) as { media_id: string; username: string } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM answers WHERE comment_id = ?').run(commentId);
  recomputeLatest(db, row.media_id, row.username);
}

function recomputeLatest(db: DB, mediaId: string, username: string): void {
  db.prepare(
    `UPDATE answers SET
       is_latest = (id = (SELECT id FROM answers WHERE media_id = @m AND username = @u
                          ORDER BY created_at DESC, id DESC LIMIT 1)),
       n_answers = (SELECT COUNT(*) FROM answers WHERE media_id = @m AND username = @u)
     WHERE media_id = @m AND username = @u`,
  ).run({ m: mediaId, u: username });
}

// ---------- participants ----------

/**
 * Recalcula la ficha del participante a partir de sus comentarios analizados (idempotente:
 * re-extraer no cuenta dos veces). El nombre de personaje que vale es el último propuesto.
 */
export function refreshParticipant(db: DB, username: string): void {
  const agg = db
    .prepare(
      `SELECT MIN(commented_at) AS first_seen, MAX(commented_at) AS last_seen, COUNT(*) AS n,
         (SELECT ig_user_id FROM comments WHERE username = @u AND ig_user_id IS NOT NULL
            ORDER BY commented_at DESC LIMIT 1) AS ig_user_id,
         (SELECT character_name FROM comments WHERE username = @u AND character_name IS NOT NULL
            AND extract_status = 'done' ORDER BY commented_at DESC LIMIT 1) AS character_name
       FROM comments WHERE username = @u AND extract_status = 'done'`,
    )
    .get({ u: username }) as {
    first_seen: number | null;
    last_seen: number | null;
    n: number;
    ig_user_id: string | null;
    character_name: string | null;
  };
  if (!agg.n || agg.first_seen === null || agg.last_seen === null) {
    db.prepare('DELETE FROM participants WHERE username = ?').run(username);
    return;
  }
  db.prepare(
    `INSERT INTO participants (username, ig_user_id, character_name, first_seen, last_seen, n_comments)
     VALUES (@username, @ig_user_id, @character_name, @first_seen, @last_seen, @n)
     ON CONFLICT (username) DO UPDATE SET
       ig_user_id = excluded.ig_user_id, character_name = excluded.character_name,
       first_seen = excluded.first_seen, last_seen = excluded.last_seen,
       n_comments = excluded.n_comments`,
  ).run({ username, ...agg });
}
