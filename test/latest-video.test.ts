import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { buildReplyUserMessage } from '../src/llm/reply.js';
import { createLatestVideoTracker, type LatestVideoTracker } from '../src/pipeline/latestVideo.js';
import { createReplyStep } from '../src/pipeline/replyStep.js';
import type { MediaView } from '../src/pipeline/context.js';
import type { ReadClient } from '../src/meta/readClient.js';
import { fakeLlm, silentLogger, testLists, testPrompts } from './helpers/fakes.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-07T12:00:00Z');

describe('mensaje al modelo según si el vídeo es el último', () => {
  const base = { username: 'pepe', text: 'que se llame Marcos', caption: null, question: '¿cómo se llama el protagonista?', parent: null };
  it('vídeo antiguo: avisa de que hay un día más nuevo', () => {
    const m = buildReplyUserMessage({ ...base, newerVideo: { postedAt: Date.parse('2026-11-05T18:00:00Z') } });
    expect(m).toContain('Este vídeo NO es el último');
    expect(m).toContain('5 de noviembre');
  });
  it('último vídeo: lo indica', () => {
    expect(buildReplyUserMessage({ ...base, newerVideo: null })).toContain('Este vídeo es el último publicado.');
  });
  it('sin información: no dice nada', () => {
    expect(buildReplyUserMessage(base)).not.toMatch(/es el último|NO es el último/);
  });
});

describe('seguimiento del último vídeo', () => {
  function fakeRead(list: { id: string; media_type?: string; timestamp?: string; shortcode?: string }[]) {
    let calls = 0;
    const read = { getRecentMedia: async () => (calls++, list) } as unknown as ReadClient;
    return { read, calls: () => calls };
  }

  it('cachea 10 minutos y prefiere vídeos', async () => {
    let t = NOW;
    const r = fakeRead([{ id: 'foto', media_type: 'IMAGE' }, { id: 'reel', media_type: 'VIDEO', timestamp: '2026-11-06T10:00:00+0000' }]);
    const tracker = createLatestVideoTracker({ read: r.read, logger: silentLogger, now: () => t });
    expect((await tracker.get())?.mediaId).toBe('reel');
    await tracker.get();
    expect(r.calls()).toBe(1);
    t += 11 * 60_000;
    await tracker.get();
    expect(r.calls()).toBe(2);
  });

  it('IGNORED_REELS: un reel de prueba no cuenta como el último (por ID o por shortcode)', async () => {
    const list = [
      { id: 'prueba1', media_type: 'VIDEO', shortcode: 'PRB1' },
      { id: 'prueba2', media_type: 'VIDEO', shortcode: 'PRB2' },
      { id: 'dia3', media_type: 'VIDEO', shortcode: 'DIA3' },
    ];
    const tracker = createLatestVideoTracker({ read: fakeRead(list).read, logger: silentLogger, ignored: ['PRB1', 'prueba2'] });
    expect((await tracker.get())?.mediaId).toBe('dia3');
    expect((await createLatestVideoTracker({ read: fakeRead(list).read, logger: silentLogger }).get())?.mediaId).toBe('prueba1');
  });

  it('si Meta falla, devuelve lo último que sabía', async () => {
    let fail = false;
    const read = { getRecentMedia: async () => { if (fail) throw new Error('caído'); return [{ id: 'r1', media_type: 'VIDEO' }]; } } as unknown as ReadClient;
    const tracker = createLatestVideoTracker({ read, logger: silentLogger, ttlMs: 0 });
    await tracker.get();
    fail = true;
    expect((await tracker.get())?.mediaId).toBe('r1');
  });
});

describe('paso de respuesta con vídeos antiguos', () => {
  function run(media: Partial<MediaView>, latest: { mediaId: string; postedAt: number }, label: string | null = 'marcos') {
    const { llm, calls } = fakeLlm(() => ({ reply: 've a ver el nuevo día!! 👀', reason: 'vídeo antiguo' }));
    let gets = 0;
    const tracker: LatestVideoTracker = { get: async () => (gets++, { ...latest, permalink: null }) };
    const step = createReplyStep({
      db: openDb(':memory:'), llm, prompts: testPrompts, lists: testLists, logger: silentLogger,
      settings: { delayMinSec: 60, delayMaxSec: 300, reviewMode: true, maxAgeHours: 0 }, latest: tracker, now: () => NOW,
    });
    const ctx = {
      row: { comment_id: 'c', username: 'pepe', text: 'que se llame Marcos', commented_at: NOW, source: 'webhook', status: 'processing' } as never,
      media: { mediaId: 'm1', caption: null, permalink: null, shortcode: null, isOwn: true, question: null, questionSource: null, ...media } as MediaView,
      threadId: 'c', parentId: null, parent: null, hidden: false, label, extractError: null,
    };
    return { out: step(ctx), calls, gets: () => gets };
  }

  it('comentario en un vídeo antiguo: el modelo lo sabe y no hay llamada extra a Meta', async () => {
    const r = run({ mediaId: 'viejo', postedAt: NOW - 5 * DAY }, { mediaId: 'nuevo', postedAt: NOW - DAY });
    expect(await r.out).toMatchObject({ status: 'pending_review', patch: { reply_text: '@pepe ve a ver el nuevo día!! 👀' } });
    expect(r.calls[0]!.user).toContain('Este vídeo NO es el último');
    expect(r.gets()).toBe(1);
  });

  it('comentario en el último vídeo', async () => {
    const r = run({ mediaId: 'nuevo', postedAt: NOW - DAY }, { mediaId: 'nuevo', postedAt: NOW - DAY });
    await r.out;
    expect(r.calls[0]!.user).toContain('Este vídeo es el último publicado.');
  });

  it('vídeo recién publicado (más nuevo que el cacheado): vuelve a preguntar a Meta', async () => {
    const r = run({ mediaId: 'recien', postedAt: NOW - 60_000 }, { mediaId: 'anterior', postedAt: NOW - DAY });
    await r.out;
    expect(r.gets()).toBe(2);
  });

  it('si el comentario no responde a la pregunta, el modelo no sabe que hay un día nuevo (ni se pregunta a Meta)', async () => {
    const r = run({ mediaId: 'viejo', postedAt: NOW - 5 * DAY }, { mediaId: 'nuevo', postedAt: NOW - DAY }, null);
    await r.out;
    expect(r.calls[0]!.user).not.toMatch(/es el último|día más nuevo/);
    expect(r.gets()).toBe(0);
  });
});
