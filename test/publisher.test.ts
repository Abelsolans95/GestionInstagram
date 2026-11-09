import { describe, expect, it } from 'vitest';
import { getComment, insertCommentIfNew, updateComment } from '../src/db/comments.js';
import { openDb, type DB } from '../src/db/index.js';
import type { FetchLike } from '../src/meta/http.js';
import { createReadClient } from '../src/meta/readClient.js';
import { createPublisher } from '../src/worker/publisher.js';
import { createFakeMeta } from './helpers/fakeMeta.js';
import { IG_USER_ID, OWN_USERNAME, silentLogger } from './helpers/fakes.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const HOUR = 3_600_000;

function scheduled(db: DB, id: string, opts: { at?: number; target?: string; text?: string; source?: 'webhook' | 'import' } = {}) {
  insertCommentIfNew(db, { commentId: id, mediaId: 'm1', parentId: null, parentChecked: true, igUserId: 'ig-u', username: 'pepe', text: 'hola', commentedAt: NOW - HOUR, source: opts.source ?? 'webhook', status: 'queued' });
  updateComment(db, id, { status: 'scheduled', reply_text: opts.text ?? '@pepe 🔥🔥', reply_target_id: opts.target ?? '17000000000000001', publish_at: opts.at ?? NOW - 1000 });
}

function setup(opts: { maxPerHour?: number; likeComments?: boolean; fetch?: (base: FetchLike) => FetchLike; existingReplies?: { id: string; text: string; username: string }[] } = {}) {
  const meta = createFakeMeta({
    igUserId: IG_USER_ID,
    username: OWN_USERNAME,
    media: [],
    threads: { m1: [{ comment: { id: '17000000000000001', text: 'hola', username: 'pepe' }, replies: opts.existingReplies ?? [] }] },
  });
  const fetchImpl = opts.fetch ? opts.fetch(meta.fetch) : meta.fetch;
  const graph = { baseUrl: 'https://graph.instagram.com', version: 'v27.0', getAccessToken: () => 'tok', fetch: fetchImpl, sleep: async () => {} };
  const db = openDb(':memory:');
  let now = NOW;
  const publisher = createPublisher({
    db,
    graph,
    read: createReadClient({ graph, igUserId: IG_USER_ID }),
    logger: silentLogger,
    maxPerHour: opts.maxPerHour ?? 60,
    igUserId: IG_USER_ID,
    ownUsername: () => OWN_USERNAME,
    likeComments: opts.likeComments ?? false,
    now: () => now,
  });
  return { db, meta, publisher, advance: (ms: number) => (now += ms) };
}

describe('publicador (cliente de escritura)', () => {
  it('publica con POST /{comment-id}/replies {"message"} y marca replied', async () => {
    const { db, meta, publisher } = setup();
    scheduled(db, 'c1');
    expect(await publisher.tick()).toBe(1);
    expect(meta.posts()).toEqual([
      { method: 'POST', path: '/17000000000000001/replies', params: { access_token: 'tok' }, body: { message: '@pepe 🔥🔥' } },
    ]);
    expect(getComment(db, 'c1')).toMatchObject({ status: 'replied', replied_at: NOW, reply_comment_id: 'reply-1', publish_attempts: 1 });
  });

  it('no publica antes de publish_at (delay aleatorio)', async () => {
    const { db, meta, publisher, advance } = setup();
    scheduled(db, 'c1', { at: NOW + 120_000 });
    expect(await publisher.tick()).toBe(0);
    advance(120_000);
    expect(await publisher.tick()).toBe(1);
    expect(meta.posts()).toHaveLength(1);
  });

  it('publica como mucho una por ciclo, en orden de publish_at', async () => {
    const { db, meta, publisher } = setup();
    scheduled(db, 'b', { at: NOW - 1000 });
    scheduled(db, 'a', { at: NOW - 5000 });
    await publisher.tick();
    expect(getComment(db, 'a')!.status).toBe('replied');
    expect(getComment(db, 'b')!.status).toBe('scheduled');
    await publisher.tick();
    expect(meta.posts()).toHaveLength(2);
  });

  it('respeta MAX_REPLIES_PER_HOUR en ventana móvil: lo que no cabe espera', async () => {
    const { db, meta, publisher, advance } = setup({ maxPerHour: 2 });
    for (const id of ['a', 'b', 'c']) scheduled(db, id);
    await publisher.tick();
    await publisher.tick();
    expect(await publisher.tick()).toBe(0); // tope alcanzado
    expect(getComment(db, 'c')!.status).toBe('scheduled');
    advance(HOUR + 1);
    expect(await publisher.tick()).toBe(1);
    expect(meta.posts()).toHaveLength(3);
  });

  it('nunca publica un comentario importado', async () => {
    const { db, meta, publisher } = setup();
    scheduled(db, 'imp', { source: 'import' });
    expect(await publisher.tick()).toBe(0);
    expect(meta.posts()).toEqual([]);
  });

  it('error definitivo de Meta (p. ej. comentario borrado) → failed, sin reintentos', async () => {
    const { db, publisher } = setup({
      fetch: (base) => async (u, i) => (i.method === 'POST' ? new Response('{"error":{"message":"Unsupported post request","code":100}}', { status: 400 }) : base(u, i)),
    });
    scheduled(db, 'c1');
    await publisher.tick();
    expect(getComment(db, 'c1')).toMatchObject({ status: 'failed', decision: 'publish_failed' });
  });

  it('error ambiguo (5xx): si la respuesta ya se publicó, no la duplica', async () => {
    let posts = 0;
    const { db, publisher } = setup({
      existingReplies: [{ id: 'ya-publicada', text: '@pepe 🔥🔥', username: OWN_USERNAME }],
      fetch: (base) => async (u, i) => {
        if (i.method === 'POST') {
          posts++;
          return new Response('{}', { status: 502 });
        }
        return base(u, i);
      },
    });
    scheduled(db, 'c1');
    await publisher.tick();
    expect(posts).toBe(1);
    expect(getComment(db, 'c1')).toMatchObject({ status: 'replied', reply_comment_id: 'ya-publicada' });
  });

  it('error ambiguo sin rastro de la respuesta: reintenta con backoff y a los 3 intentos, failed', async () => {
    const { db, publisher, advance } = setup({
      fetch: (base) => async (u, i) => (i.method === 'POST' ? new Response('{}', { status: 503 }) : base(u, i)),
    });
    scheduled(db, 'c1');
    await publisher.tick();
    expect(getComment(db, 'c1')).toMatchObject({ status: 'scheduled', publish_attempts: 1, publish_at: NOW + 60_000 });
    advance(60_000);
    await publisher.tick();
    expect(getComment(db, 'c1')).toMatchObject({ status: 'scheduled', publish_attempts: 2 });
    advance(120_000);
    await publisher.tick();
    expect(getComment(db, 'c1')).toMatchObject({ status: 'failed', publish_attempts: 3 });
  });

  it('tras un reinicio a mitad de publicación, comprueba antes de volver a publicar', async () => {
    const { db, meta, publisher } = setup({ existingReplies: [{ id: 'r9', text: '@pepe 🔥🔥', username: OWN_USERNAME }] });
    scheduled(db, 'ya');
    scheduled(db, 'no', { text: '@pepe otra' });
    updateComment(db, 'ya', { status: 'publishing' });
    updateComment(db, 'no', { status: 'publishing' });
    await publisher.recover();
    expect(getComment(db, 'ya')).toMatchObject({ status: 'replied', reply_comment_id: 'r9' });
    expect(getComment(db, 'no')!.status).toBe('scheduled');
    expect(meta.posts()).toEqual([]);
  });
});

describe('comentarios que ya no existen', () => {
  it('si Meta dice que el comentario no existe, queda como no disponible (no como fallido)', async () => {
    const { db, publisher } = setup({
      fetch: (base) => async (u, i) =>
        i.method === 'POST'
          ? new Response(
              JSON.stringify({ error: { message: "Unsupported post request. Object with ID '17000000000000001' does not exist, cannot be loaded due to missing permissions, or does not support this operation.", code: 100, error_subcode: 33 } }),
              { status: 400 },
            )
          : base(u, i),
    });
    scheduled(db, 'c1');
    await publisher.tick();
    expect(getComment(db, 'c1')).toMatchObject({ status: 'skipped', decision: 'comment_unavailable' });
  });

  it('pero si el token tampoco puede leer tu cuenta (token de otra cuenta), es un fallo que se reintenta', async () => {
    const missing = (id: string) =>
      new Response(
        JSON.stringify({ error: { message: `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, code: 100, error_subcode: 33 } }),
        { status: 400 },
      );
    const { db, publisher } = setup({
      fetch: () => async (u) => missing(new URL(u).pathname.split('/').filter(Boolean).at(-1) ?? ''),
    });
    scheduled(db, 'c1');
    await publisher.tick();
    expect(getComment(db, 'c1')).toMatchObject({ status: 'failed', decision: 'publish_failed' });
  });
});

describe('me gusta a los comentarios respondidos', () => {
  it('apagado por defecto: solo publica la respuesta', async () => {
    const { db, meta, publisher } = setup();
    scheduled(db, 'c1');
    await publisher.tick();
    expect(meta.posts().map((p) => p.path)).toEqual(['/17000000000000001/replies']);
  });

  it('activado: tras responder, POST /{IG_USER_ID}/likes {"comment_id"} del comentario del seguidor', async () => {
    const { db, meta, publisher } = setup({ likeComments: true });
    scheduled(db, '18000000000000123', { target: '17000000000000001' });
    await publisher.tick();
    expect(meta.posts()[1]).toMatchObject({ path: `/${IG_USER_ID}/likes`, body: { comment_id: '18000000000000123' } });
  });

  it('si Meta lo rechaza por permisos, la respuesta queda publicada y deja de intentarlo', async () => {
    let likes = 0;
    const { db, publisher } = setup({
      likeComments: true,
      fetch: (base) => async (u, i) => {
        if (i.method === 'POST' && u.includes('/likes')) {
          likes++;
          return new Response('{"error":{"message":"(#10) Application does not have permission for this action","code":10}}', { status: 403 });
        }
        return base(u, i);
      },
    });
    scheduled(db, '18000000000000001');
    scheduled(db, '18000000000000002', { at: NOW - 500 });
    await publisher.tick();
    await publisher.tick();
    expect(getComment(db, '18000000000000001')!.status).toBe('replied');
    expect(getComment(db, '18000000000000002')!.status).toBe('replied');
    expect(likes).toBe(1);
  });
});
