/**
 * Plan B (apagado por defecto): si los webhooks de comentarios no llegan (p. ej. porque Meta exige
 * que la app esté en modo Live), lee periódicamente los comentarios de tus últimos vídeos con el
 * cliente de LECTURA y los mete en la misma cola idempotente (status 'queued', source 'poll').
 *
 * Solo encola comentarios posteriores al momento en que se activó por primera vez (kv
 * 'poll_since'), para no responder de golpe a todo lo antiguo. Lo antiguo se analiza con
 * `pnpm import:comments`, que no responde. Por vídeo revisa la primera página de comentarios
 * (los 50 más recientes, con sus respuestas).
 */
import { kvGet, kvSet, type DB } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { ReadClient } from '../meta/readClient.js';
import type { IgComment } from '../meta/types.js';
import { errorMessage } from '../pipeline/log.js';
import type { CommentQueue } from '../queue/commentQueue.js';
import type { CommentEvent } from '../webhook/parse.js';

export interface PollerOptions {
  db: DB;
  read: ReadClient;
  queue: CommentQueue;
  logger: Logger;
  intervalSec: number;
  mediaCount: number;
  now?: () => number;
}

const THREADS_PER_MEDIA = 50;

export function createPoller(opts: PollerOptions) {
  const now = opts.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  let busy = false;

  function since(): number {
    const v = kvGet<number>(opts.db, 'poll_since');
    if (v) return v;
    const t = now();
    kvSet(opts.db, 'poll_since', t, t);
    opts.logger.info({ since: new Date(t).toISOString() }, 'polling activado: solo comentarios desde ahora');
    return t;
  }

  function toEvent(c: IgComment, mediaId: string, parentId: string | null): CommentEvent {
    const ts = c.timestamp ? Date.parse(c.timestamp) : NaN;
    return {
      commentId: c.id,
      mediaId,
      text: c.text ?? '',
      fromId: c.from?.id ?? null,
      fromUsername: c.username ?? c.from?.username ?? null,
      parentId,
      mediaProductType: null,
      accountId: null,
      sentAt: Number.isNaN(ts) ? null : Math.floor(ts / 1000),
    };
  }

  async function tick(): Promise<{ inserted: number }> {
    const from = since();
    const isNew = (c: IgComment) => !!c.timestamp && Date.parse(c.timestamp) >= from;
    const events: CommentEvent[] = [];
    let mediaSeen = 0;
    for await (const m of opts.read.listMedia()) {
      if (++mediaSeen > opts.mediaCount) break;
      let threads = 0;
      for await (const t of opts.read.listThreads(m.id)) {
        if (++threads > THREADS_PER_MEDIA) break;
        if (isNew(t.comment)) events.push(toEvent(t.comment, m.id, null));
        for (const r of t.replies) if (isNew(r)) events.push(toEvent(r, m.id, t.comment.id));
      }
    }
    // Los ya conocidos (de webhook, importados o respondidos) los ignora el INSERT OR IGNORE.
    const res = opts.queue.enqueuePolledEvents(events, new Date(now()));
    if (res.inserted.length) opts.logger.info({ inserted: res.inserted }, 'comentarios nuevos encontrados por polling');
    return { inserted: res.inserted.length };
  }

  return {
    tick,
    start() {
      if (timer || opts.intervalSec <= 0) return;
      since();
      timer = setInterval(() => {
        if (busy) return;
        busy = true;
        tick()
          .catch((err) => opts.logger.error({ err: errorMessage(err) }, 'error en el polling'))
          .finally(() => {
            busy = false;
          });
      }, opts.intervalSec * 1000);
      opts.logger.info({ intervalSec: opts.intervalSec, mediaCount: opts.mediaCount }, 'polling de comentarios arrancado');
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
