import type { DB } from '../db/index.js';

export interface ReportPerson {
  username: string;
  answer: string | null;
  rawText: string;
  commentId: string;
  createdAt: number;
  /** Respondió varias veces a esta pregunta (cuenta la última). */
  multiple: boolean;
  nAnswers: number;
}

export interface ReportGroup {
  label: string;
  count: number;
  people: ReportPerson[];
}

export interface NonAnswer {
  username: string | null;
  text: string;
  commentId: string;
  createdAt: number;
}

export interface MediaReport {
  mediaId: string;
  permalink: string | null;
  question: string | null;
  questionSource: string | null;
  postedAt: number | null;
  groups: ReportGroup[];
  nonAnswers: NonAnswer[];
  totalPeople: number;
  /** Comentarios guardados sin analizar (p. ej. de una cuenta sin prompt de análisis). */
  pendingAnalysis: number;
  /** Quién más ha comentado en el vídeo (comentarios y respuestas en hilos; sin los tuyos). */
  topCommenters: { username: string; count: number }[];
  /** Comentarios de seguidores guardados del vídeo (sin los tuyos). */
  totalComments: number;
}

export const NO_LABEL = '(sin etiqueta)';

/** Respuestas a la pregunta de un vídeo agrupadas por etiqueta, de más a menos personas. */
export function buildMediaReport(db: DB, mediaId: string): MediaReport | null {
  const media = db
    .prepare('SELECT media_id, permalink, question, question_source, posted_at FROM media WHERE media_id = ?')
    .get(mediaId) as
    | { media_id: string; permalink: string | null; question: string | null; question_source: string | null; posted_at: number | null }
    | undefined;
  const hasData = db.prepare('SELECT 1 FROM comments WHERE media_id = ? LIMIT 1').get(mediaId);
  if (!media && !hasData) return null;

  const rows = db
    .prepare(
      `SELECT COALESCE(answer_label, '${NO_LABEL}') AS label, username, answer, raw_text, comment_id, created_at, n_answers
       FROM answers WHERE media_id = ? AND is_latest = 1
       ORDER BY created_at, id`,
    )
    .all(mediaId) as {
    label: string;
    username: string;
    answer: string | null;
    raw_text: string;
    comment_id: string;
    created_at: number;
    n_answers: number;
  }[];

  const byLabel = new Map<string, ReportPerson[]>();
  for (const r of rows) {
    const list = byLabel.get(r.label) ?? [];
    list.push({
      username: r.username,
      answer: r.answer,
      rawText: r.raw_text,
      commentId: r.comment_id,
      createdAt: r.created_at,
      multiple: r.n_answers > 1,
      nAnswers: r.n_answers,
    });
    byLabel.set(r.label, list);
  }
  const groups = [...byLabel.entries()]
    .map(([label, people]) => ({ label, count: people.length, people }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));

  const nonAnswers = (
    db
      .prepare(
        `SELECT username, text, comment_id, commented_at FROM comments
         WHERE media_id = ? AND extract_status = 'done' AND answers_question = 0
         ORDER BY commented_at`,
      )
      .all(mediaId) as { username: string | null; text: string; comment_id: string; commented_at: number }[]
  ).map((r) => ({ username: r.username, text: r.text, commentId: r.comment_id, createdAt: r.commented_at }));

  return {
    mediaId,
    permalink: media?.permalink ?? null,
    question: media?.question ?? null,
    questionSource: media?.question_source ?? null,
    postedAt: media?.posted_at ?? null,
    groups,
    nonAnswers,
    totalPeople: rows.length,
    pendingAnalysis: (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM comments
           WHERE media_id = ? AND extract_status IS NULL AND status NOT IN ('queued', 'processing')
             AND COALESCE(decision, '') NOT IN ('own_comment', 'spam', 'not_own_media')`,
        )
        .get(mediaId) as { n: number }
    ).n,
    topCommenters: db
      .prepare(
        `SELECT username, COUNT(*) AS count FROM comments
         WHERE media_id = ? AND username IS NOT NULL AND COALESCE(decision, '') != 'own_comment'
         GROUP BY username ORDER BY count DESC, MIN(commented_at) LIMIT 10`,
      )
      .all(mediaId) as { username: string; count: number }[],
    totalComments: (
      db
        .prepare(`SELECT COUNT(*) AS n FROM comments WHERE media_id = ? AND COALESCE(decision, '') != 'own_comment'`)
        .get(mediaId) as { n: number }
    ).n,
  };
}

export interface MediaSummary {
  mediaId: string;
  accountId: string | null;
  permalink: string | null;
  question: string | null;
  postedAt: number | null;
  people: number;
  comments: number;
}

/** Índice de vídeos con comentarios analizados. */
export function listReportMedia(db: DB): MediaSummary[] {
  return (
    db
      .prepare(
        `SELECT m.media_id, m.account_id, m.permalink, m.question, m.posted_at,
           (SELECT COUNT(*) FROM answers a WHERE a.media_id = m.media_id AND a.is_latest = 1) AS people,
           (SELECT COUNT(*) FROM comments c WHERE c.media_id = m.media_id AND c.extract_status = 'done') AS comments
         FROM media m WHERE m.is_own IS NOT 0
         ORDER BY COALESCE(m.posted_at, m.fetched_at) DESC`,
      )
      .all() as { media_id: string; account_id: string | null; permalink: string | null; question: string | null; posted_at: number | null; people: number; comments: number }[]
  ).map((r) => ({
    mediaId: r.media_id,
    accountId: r.account_id,
    permalink: r.permalink,
    question: r.question,
    postedAt: r.posted_at,
    people: r.people,
    comments: r.comments,
  }));
}

export interface ParticipantAnswer {
  label: string | null;
  answer: string | null;
  multiple: boolean;
}

export interface ParticipantCard {
  username: string;
  characterName: string | null;
  nComments: number;
  firstSeen: number;
  lastSeen: number;
  answers: Record<string, ParticipantAnswer>;
}

export interface ParticipantsReport {
  media: { mediaId: string; question: string | null; permalink: string | null; postedAt: number | null }[];
  participants: ParticipantCard[];
}

/**
 * Ficha por seguidor: @usuario, nombre de personaje y su respuesta (la que cuenta) en cada vídeo.
 * Con varias cuentas, de una cuenta (sin accountId, de todas).
 */
export function buildParticipantsReport(db: DB, accountId?: string | null): ParticipantsReport {
  const account = accountId ?? null;
  const media = (
    db
      .prepare(
        `SELECT DISTINCT m.media_id, m.question, m.permalink, m.posted_at, m.fetched_at FROM media m
         JOIN answers a ON a.media_id = m.media_id
         WHERE @account IS NULL OR m.account_id = @account
         ORDER BY COALESCE(m.posted_at, m.fetched_at)`,
      )
      .all({ account }) as { media_id: string; question: string | null; permalink: string | null; posted_at: number | null }[]
  ).map((m) => ({ mediaId: m.media_id, question: m.question, permalink: m.permalink, postedAt: m.posted_at }));

  const people = db
    .prepare('SELECT * FROM participants WHERE @account IS NULL OR account_id = @account ORDER BY n_comments DESC, username')
    .all({ account }) as { username: string; character_name: string | null; n_comments: number; first_seen: number; last_seen: number }[];

  const answers = db
    .prepare(
      `SELECT a.username, a.media_id, a.answer_label, a.answer, a.n_answers FROM answers a
       JOIN media m ON m.media_id = a.media_id
       WHERE a.is_latest = 1 AND (@account IS NULL OR m.account_id = @account)`,
    )
    .all({ account }) as { username: string; media_id: string; answer_label: string | null; answer: string | null; n_answers: number }[];
  const byUser = new Map<string, Record<string, ParticipantAnswer>>();
  for (const a of answers) {
    const rec = byUser.get(a.username) ?? {};
    rec[a.media_id] = { label: a.answer_label, answer: a.answer, multiple: a.n_answers > 1 };
    byUser.set(a.username, rec);
  }

  return {
    media,
    participants: people.map((p) => ({
      username: p.username,
      characterName: p.character_name,
      nComments: p.n_comments,
      firstSeen: p.first_seen,
      lastSeen: p.last_seen,
      answers: byUser.get(p.username) ?? {},
    })),
  };
}
