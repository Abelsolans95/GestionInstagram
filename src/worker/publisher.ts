/**
 * Publicador del worker de respuestas: el ÚNICO módulo que usa el cliente de escritura de Meta.
 *
 *  - Publica las respuestas 'scheduled' cuyo publish_at (ahora + delay aleatorio) ya ha pasado.
 *  - Respeta MAX_REPLIES_PER_HOUR en una ventana móvil de 60 min; lo que no cabe espera.
 *  - Publica como mucho una por ciclo (cada ~10 s) para no soltar ráfagas.
 *  - Nunca publica un comentario importado.
 *  - Ante un fallo ambiguo (sin respuesta de Meta, 5xx), antes de reintentar comprueba si la
 *    respuesta ya se publicó, para no duplicarla. Tras 3 intentos, 'failed'.
 */
import { updateComment, type CommentRow } from '../db/comments.js';
import type { DB } from '../db/index.js';
import type { Logger } from '../logger.js';
import { MetaApiError, type GraphContext } from '../meta/http.js';
import type { ReadClient } from '../meta/readClient.js';
import { createWriteClient, type WriteClient } from '../meta/writeClient.js';
import { errorMessage, logCommentOutcome } from '../pipeline/log.js';

const HOUR_MS = 3_600_000;
export const MAX_PUBLISH_ATTEMPTS = 3;

export interface PublisherOptions {
  db: DB;
  graph: GraphContext;
  read: ReadClient;
  logger: Logger;
  maxPerHour: number;
  igUserId: string;
  ownUsername: () => string | null;
  tickMs?: number;
  now?: () => number;
}

export interface Publisher {
  /** Un ciclo: publica como mucho una respuesta. Devuelve cuántas ha publicado (0 o 1). */
  tick(): Promise<number>;
  /** Recupera las que quedaron en 'publishing' por un reinicio. */
  recover(): Promise<void>;
  repliesLastHour(): number;
  start(): void;
  stop(): Promise<void>;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/**
 * Meta responde "Unsupported post request. Object with ID '…' does not exist, cannot be loaded
 * due to missing permissions, or does not support this operation" (código 100, subcódigo 33)
 * cuando el comentario se ha borrado u ocultado.
 */
export function isCommentUnavailable(err: unknown): boolean {
  return (
    err instanceof MetaApiError &&
    err.status === 400 &&
    err.code === 100 &&
    (err.subcode === 33 || /does not exist/i.test(err.message))
  );
}

function classify(err: unknown): 'rate_limited' | 'ambiguous' | 'definitive' {
  if (!(err instanceof MetaApiError)) return 'ambiguous';
  if (err.status === null || err.status >= 500) return 'ambiguous';
  if (err.status === 429 || (err.code !== null && RATE_LIMIT_CODES.has(err.code))) return 'rate_limited';
  return 'definitive';
}

export function createPublisher(opts: PublisherOptions): Publisher {
  const { db, logger } = opts;
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 10_000;
  const write: WriteClient = createWriteClient(opts.graph);
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;
  let capLogged = false;

  const countLastHour = db.prepare(
    "SELECT COUNT(*) AS n FROM comments WHERE replied_at >= ? OR status = 'publishing'",
  );
  const nextDue = db.prepare(
    `SELECT comment_id FROM comments
     WHERE status = 'scheduled' AND source != 'import' AND publish_at IS NOT NULL AND publish_at <= ?
     ORDER BY publish_at LIMIT 1`,
  );
  const claim = db.prepare(
    `UPDATE comments SET status = 'publishing', publish_attempts = publish_attempts + 1, updated_at = ?
     WHERE comment_id = ? AND status = 'scheduled' AND source != 'import' RETURNING *`,
  );

  function repliesLastHour(): number {
    return (countLastHour.get(now() - HOUR_MS) as { n: number }).n;
  }

  /** ¿Ya existe en el hilo una respuesta nuestra con este texto? (para no duplicar) */
  async function alreadyPublished(row: CommentRow): Promise<string | null> {
    if (!row.reply_target_id || !row.reply_text) return null;
    const own = opts.ownUsername()?.toLowerCase() ?? null;
    for await (const r of opts.read.listReplies(row.reply_target_id)) {
      const mine =
        (r.from?.id && r.from.id === opts.igUserId) ||
        (own !== null && (r.username ?? r.from?.username ?? '').toLowerCase() === own);
      if (mine && (r.text ?? '').trim() === row.reply_text.trim()) return r.id;
    }
    return null;
  }

  function markReplied(row: CommentRow, replyId: string, started: number, note?: string) {
    updateComment(db, row.comment_id, { status: 'replied', replied_at: now(), reply_comment_id: replyId, last_error: null }, now());
    logCommentOutcome(logger, {
      comment_id: row.comment_id,
      username: row.username,
      origin: row.source,
      decision: 'published',
      reason: note ?? row.reason,
      label: row.answer_label,
      latency_ms: Date.now() - started,
      reply_comment_id: replyId,
      status: 'replied',
    });
  }

  async function publish(row: CommentRow): Promise<number> {
    const started = Date.now();
    const target = row.reply_target_id ?? row.comment_id;
    try {
      if (!row.reply_text) throw new Error('sin texto de respuesta');
      const res = await write.replyToComment(target, row.reply_text);
      markReplied(row, res.id, started);
      return 1;
    } catch (err) {
      const kind = classify(err);
      const msg = errorMessage(err);
      if (kind === 'ambiguous') {
        // Puede que Meta sí la publicara y se perdiera la respuesta: comprobarlo antes de reintentar.
        try {
          const existing = await alreadyPublished({ ...row, reply_target_id: target });
          if (existing) {
            markReplied(row, existing, started, 'publicada (confirmada tras un error de red)');
            return 1;
          }
        } catch (verifyErr) {
          logger.warn({ comment_id: row.comment_id, err: errorMessage(verifyErr) }, 'no se pudo comprobar si ya estaba publicada');
          // Sin poder comprobarlo no reintentamos a ciegas: mejor no duplicar.
          updateComment(db, row.comment_id, { status: 'failed', decision: 'publish_failed', last_error: `${msg}; sin verificar si se publicó` }, now());
          return 0;
        }
      }
      // El comentario ya no existe o no se puede responder (borrado u ocultado por su autor o por
      // Instagram): no es un fallo que reintentar, se marca como no disponible.
      if (isCommentUnavailable(err)) {
        updateComment(
          db,
          row.comment_id,
          {
            status: 'skipped',
            decision: 'comment_unavailable',
            reason: 'el comentario ya no existe o está oculto: no se puede responder',
            last_error: msg,
          },
          now(),
        );
        logCommentOutcome(logger, {
          comment_id: row.comment_id,
          username: row.username,
          origin: row.source,
          decision: 'comment_unavailable',
          reason: 'el comentario ya no existe o está oculto',
          latency_ms: Date.now() - started,
          error: msg,
        });
        return 0;
      }
      const attempts = row.publish_attempts;
      const giveUp = kind === 'definitive' || attempts >= MAX_PUBLISH_ATTEMPTS;
      const backoffMs = kind === 'rate_limited' ? 15 * 60_000 : 60_000 * 2 ** (attempts - 1);
      updateComment(
        db,
        row.comment_id,
        giveUp
          ? { status: 'failed', decision: 'publish_failed', last_error: msg }
          : { status: 'scheduled', publish_at: now() + backoffMs, last_error: msg },
        now(),
      );
      logCommentOutcome(logger, {
        comment_id: row.comment_id,
        username: row.username,
        origin: row.source,
        decision: giveUp ? 'publish_failed' : 'publish_retry',
        reason: kind,
        latency_ms: Date.now() - started,
        error: msg,
        attempts,
      });
      return 0;
    }
  }

  async function tick(): Promise<number> {
    const used = repliesLastHour();
    if (used >= opts.maxPerHour) {
      if (!capLogged) logger.info({ used, max: opts.maxPerHour }, 'tope de respuestas por hora alcanzado; esperando');
      capLogged = true;
      return 0;
    }
    capLogged = false;
    const due = nextDue.get(now()) as { comment_id: string } | undefined;
    if (!due) return 0;
    const row = claim.get(now(), due.comment_id) as CommentRow | undefined;
    if (!row) return 0;
    return publish(row);
  }

  async function recover(): Promise<void> {
    const stuck = db.prepare("SELECT * FROM comments WHERE status = 'publishing'").all() as CommentRow[];
    for (const row of stuck) {
      try {
        const existing = await alreadyPublished(row);
        if (existing) markReplied(row, existing, Date.now(), 'publicada (confirmada tras un reinicio)');
        else updateComment(db, row.comment_id, { status: 'scheduled', publish_at: now() }, now());
      } catch (err) {
        updateComment(db, row.comment_id, { status: 'failed', decision: 'publish_failed', last_error: `reinicio durante la publicación: ${errorMessage(err)}` }, now());
      }
    }
    if (stuck.length) logger.warn({ n: stuck.length }, 'publicaciones recuperadas tras un reinicio');
  }

  return {
    tick,
    recover,
    repliesLastHour,
    start() {
      if (timer) return;
      running = recover().catch((err) => logger.error({ err: errorMessage(err) }, 'error recuperando publicaciones'));
      timer = setInterval(() => {
        if (running) return; // un ciclo cada vez
        running = tick()
          .catch((err) => logger.error({ err: errorMessage(err) }, 'error en el publicador'))
          .finally(() => {
            running = null;
          });
      }, tickMs);
      void running.finally(() => {
        running = null;
      });
      logger.info({ tickMs, maxPerHour: opts.maxPerHour }, 'publicador arrancado');
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}

/** Para `pnpm review stats` y /status. */
export function pendingToPublish(db: DB, now = Date.now()): { due: number; later: number } {
  const r = db
    .prepare(
      `SELECT SUM(publish_at <= ?) AS due, SUM(publish_at > ?) AS later FROM comments WHERE status = 'scheduled'`,
    )
    .get(now, now) as { due: number | null; later: number | null };
  return { due: r.due ?? 0, later: r.later ?? 0 };
}

