import type { Logger } from '../logger.js';
import type { ReadClient } from '../meta/readClient.js';
import { errorMessage } from './log.js';

/** Tu último vídeo publicado, para saber si un comentario llega a un vídeo antiguo. */
export interface LatestVideo {
  mediaId: string;
  permalink: string | null;
  postedAt: number | null;
}

export interface LatestVideoTracker {
  /** El último vídeo (cacheado). Con force, vuelve a preguntar a Meta. */
  get(opts?: { force?: boolean }): Promise<LatestVideo | null>;
}

export function createLatestVideoTracker(opts: {
  read: ReadClient;
  logger: Logger;
  ttlMs?: number;
  now?: () => number;
}): LatestVideoTracker {
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  let cached: { value: LatestVideo | null; at: number } | null = null;

  return {
    async get({ force = false } = {}) {
      if (!force && cached && now() - cached.at < ttl) return cached.value;
      try {
        const recent = await opts.read.getRecentMedia(5);
        // Las publicaciones vienen de más reciente a más antigua; preferimos vídeos (reels).
        const m = recent.find((x) => x.media_type === 'VIDEO') ?? recent[0];
        const ts = m?.timestamp ? Date.parse(m.timestamp) : NaN;
        const value = m ? { mediaId: m.id, permalink: m.permalink ?? null, postedAt: Number.isNaN(ts) ? null : ts } : null;
        cached = { value, at: now() };
        return value;
      } catch (err) {
        opts.logger.warn({ err: errorMessage(err) }, 'no se pudo saber cuál es el último vídeo');
        return cached?.value ?? null;
      }
    },
  };
}
