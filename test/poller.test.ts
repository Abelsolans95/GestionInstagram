import { describe, expect, it } from 'vitest';
import { countByStatus, getComment } from '../src/db/comments.js';
import { kvSet, openDb } from '../src/db/index.js';
import { createReadClient } from '../src/meta/readClient.js';
import { createCommentQueue } from '../src/queue/commentQueue.js';
import { createPoller } from '../src/worker/poller.js';
import { createFakeMeta } from './helpers/fakeMeta.js';
import { IG_USER_ID, OWN_USERNAME, silentLogger } from './helpers/fakes.js';

const SINCE = Date.parse('2026-11-06T10:00:00Z');
const c = (id: string, ts: string) => ({ id, text: `t${id}`, username: `u${id}`, timestamp: ts, from: { id: `ig${id}`, username: `u${id}` } });

describe('plan B: polling de comentarios (apagado por defecto)', () => {
  function setup() {
    const meta = createFakeMeta({
      igUserId: IG_USER_ID,
      username: OWN_USERNAME,
      media: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
      threads: {
        m1: [
          { comment: c('nuevo', '2026-11-06T11:00:00+0000'), replies: [c('resp-nueva', '2026-11-06T11:30:00+0000')] },
          { comment: c('viejo', '2026-11-01T11:00:00+0000'), replies: [c('resp-a-viejo', '2026-11-06T11:10:00+0000')] },
        ],
        m3: [{ comment: c('fuera', '2026-11-06T11:00:00+0000') }],
      },
    });
    const db = openDb(':memory:');
    const graph = { baseUrl: 'https://graph.instagram.com', version: 'v27.0', getAccessToken: () => 't', fetch: meta.fetch, sleep: async () => {} };
    const queue = createCommentQueue(db);
    const poller = createPoller({ db, read: createReadClient({ graph, igUserId: IG_USER_ID }), queue, logger: silentLogger, intervalSec: 60, mediaCount: 2, now: () => SINCE + 2 * 3_600_000 });
    return { db, meta, poller };
  }

  it('encola solo comentarios posteriores a su activación, de los últimos N vídeos, con source poll', async () => {
    const { db, poller, meta } = setup();
    kvSet(db, 'poll_since', SINCE);
    expect(await poller.tick()).toEqual({ inserted: 3 });
    expect(getComment(db, 'nuevo')).toMatchObject({ status: 'queued', source: 'poll', parent_checked: 1, thread_id: 'nuevo' });
    expect(getComment(db, 'resp-nueva')).toMatchObject({ parent_id: 'nuevo', thread_id: 'nuevo' });
    expect(getComment(db, 'resp-a-viejo')).toMatchObject({ parent_id: 'viejo' });
    expect(getComment(db, 'viejo')).toBeUndefined();
    expect(getComment(db, 'fuera')).toBeUndefined(); // m3 queda fuera de POLL_MEDIA_COUNT=2
    expect(meta.posts()).toEqual([]);
  });

  it('es idempotente: lo ya visto no se vuelve a encolar', async () => {
    const { db, poller } = setup();
    kvSet(db, 'poll_since', SINCE);
    await poller.tick();
    expect(await poller.tick()).toEqual({ inserted: 0 });
    expect(countByStatus(db)).toEqual({ queued: 3 });
  });

  it('la primera vez fija "desde ahora": no responde a lo antiguo', async () => {
    const { poller } = setup();
    expect(await poller.tick()).toEqual({ inserted: 0 });
  });
});
