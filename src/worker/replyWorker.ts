import type { DB } from '../db/index.js';
import { updateComment, type CommentRow, type CommentStatus } from '../db/comments.js';
import type { Logger } from '../logger.js';
import { errorMessage, logCommentOutcome } from '../pipeline/log.js';
import type { CommentQueue } from '../queue/commentQueue.js';

/** Resultado de procesar un comentario: estado final y datos a guardar. */
export interface ProcessOutcome {
  status: Extract<CommentStatus, 'skipped' | 'pending_review' | 'scheduled' | 'failed'>;
  decision: string;
  reason?: string | null;
  /** Etiqueta extraída (para el log). */
  label?: string | null;
  error?: string | null;
  /** Columnas adicionales a guardar (texto de la respuesta, publish_at, ...). */
  patch?: Partial<CommentRow>;
}

export type CommentProcessor = (row: CommentRow) => Promise<ProcessOutcome>;

export interface ReplyWorkerOptions {
  db: DB;
  queue: CommentQueue;
  processComment: CommentProcessor;
  logger: Logger;
  pollIntervalMs?: number;
}

export interface ReplyWorker {
  /** Procesa un comentario de la cola. Devuelve false si la cola estaba vacía. */
  runOnce(): Promise<boolean>;
  /** Procesa hasta vaciar la cola (útil en tests y scripts). */
  drain(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

/**
 * Worker de respuestas: consume la cola de uno en uno.
 * Los reintentos con backoff se hacen dentro de cada llamada a Meta/Claude; si aun así falla,
 * el comentario queda en 'failed' y el worker sigue con el siguiente.
 */
export function createReplyWorker(opts: ReplyWorkerOptions): ReplyWorker {
  const { db, queue, processComment, logger } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  let running = false;
  let loopPromise: Promise<void> | null = null;
  let wake: (() => void) | null = null;

  queue.onEnqueued(() => wake?.());

  async function handle(row: CommentRow): Promise<void> {
    const started = Date.now();
    try {
      const out = await processComment(row);
      updateComment(db, row.comment_id, {
        ...out.patch,
        status: out.status,
        decision: out.decision,
        reason: out.reason ?? null,
        last_error: out.error ?? null,
      });
      logCommentOutcome(logger, {
        comment_id: row.comment_id,
        username: row.username,
        origin: row.source,
        decision: out.decision,
        reason: out.reason,
        label: out.label,
        latency_ms: Date.now() - started,
        error: out.error,
        status: out.status,
      });
    } catch (err) {
      const msg = errorMessage(err);
      updateComment(db, row.comment_id, {
        status: 'failed',
        decision: 'error',
        reason: 'excepción en el worker',
        last_error: msg,
      });
      logCommentOutcome(logger, {
        comment_id: row.comment_id,
        username: row.username,
        origin: row.source,
        decision: 'error',
        reason: 'excepción en el worker',
        latency_ms: Date.now() - started,
        error: msg,
        status: 'failed',
      });
    }
  }

  async function runOnce(): Promise<boolean> {
    const row = queue.claimNext();
    if (!row) return false;
    await handle(row);
    return true;
  }

  function idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        wake = null;
        resolve();
      }
      wake = done;
    });
  }

  async function loop(): Promise<void> {
    while (running) {
      let worked = false;
      try {
        worked = await runOnce();
      } catch (err) {
        logger.error({ err: errorMessage(err) }, 'error inesperado en el worker');
      }
      if (!worked && running) await idle(pollIntervalMs);
    }
  }

  return {
    runOnce,
    async drain() {
      let n = 0;
      while (await runOnce()) n++;
      return n;
    },
    start() {
      if (running) return;
      running = true;
      const recovered = queue.recoverStale();
      if (recovered) logger.warn({ recovered }, 'comentarios recuperados tras un reinicio');
      loopPromise = loop();
      logger.info({ pollIntervalMs }, 'worker de respuestas arrancado');
    },
    async stop() {
      running = false;
      wake?.();
      await loopPromise;
    },
  };
}
