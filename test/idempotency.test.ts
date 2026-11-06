import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { countByStatus, getComment, insertCommentIfNew } from '../src/db/comments.js';
import { openDb } from '../src/db/index.js';
import { createLogger } from '../src/logger.js';
import { createCommentQueue } from '../src/queue/commentQueue.js';
import type { CommentEvent } from '../src/webhook/parse.js';
import { computeSignature } from '../src/webhook/signature.js';
import { createReplyWorker, type CommentProcessor } from '../src/worker/replyWorker.js';
import { buildCommentPayload } from '../scripts/payload.js';

const logger = createLogger('silent');

function event(id: string, extra: Partial<CommentEvent> = {}): CommentEvent {
  return {
    commentId: id,
    mediaId: 'm1',
    text: 'hola',
    fromId: 'u1',
    fromUsername: 'pepe',
    parentId: null,
    mediaProductType: 'REELS',
    accountId: 'me',
    sentAt: 1,
    ...extra,
  };
}

function setup(processComment?: CommentProcessor) {
  const db = openDb(':memory:');
  const queue = createCommentQueue(db);
  const processor =
    processComment ??
    vi.fn<CommentProcessor>(async () => ({ status: 'skipped', decision: 'test', reason: 'ok' }));
  const worker = createReplyWorker({ db, queue, processComment: processor, logger, pollIntervalMs: 5 });
  return { db, queue, worker, processor };
}

describe('idempotencia de la cola', () => {
  it('el mismo comment_id solo se encola una vez', () => {
    const { db, queue } = setup();
    const r1 = queue.enqueueWebhookEvents([event('c1')], new Date());
    const r2 = queue.enqueueWebhookEvents([event('c1')], new Date());
    expect(r1).toEqual({ inserted: ['c1'], duplicates: [] });
    expect(r2).toEqual({ inserted: [], duplicates: ['c1'] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 1 });
  });

  it('dentro de un mismo payload también deduplica', () => {
    const { queue } = setup();
    expect(queue.enqueueWebhookEvents([event('c1'), event('c1')], new Date())).toEqual({
      inserted: ['c1'],
      duplicates: ['c1'],
    });
  });

  it('un comentario procesado no se vuelve a procesar si Meta reenvía el webhook', async () => {
    const { queue, worker, processor } = setup();
    queue.enqueueWebhookEvents([event('c1')], new Date());
    await worker.drain();
    queue.enqueueWebhookEvents([event('c1')], new Date());
    await worker.drain();
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it('un comentario importado nunca entra en la cola aunque llegue por webhook', async () => {
    const { db, queue, worker, processor } = setup();
    insertCommentIfNew(db, {
      commentId: 'c-imp',
      mediaId: 'm1',
      parentId: null,
      parentChecked: true,
      igUserId: 'u1',
      username: 'pepe',
      text: 'viejo',
      commentedAt: 1,
      source: 'import',
      status: 'imported',
    });
    const r = queue.enqueueWebhookEvents([event('c-imp')], new Date());
    expect(r.duplicates).toEqual(['c-imp']);
    await worker.drain();
    expect(processor).not.toHaveBeenCalled();
    expect(getComment(db, 'c-imp')!.status).toBe('imported');
  });

  it('guarda parent_id y thread_id cuando llegan en el payload', () => {
    const { db, queue } = setup();
    queue.enqueueWebhookEvents([event('r1', { parentId: 'p1' }), event('t1')], new Date());
    expect(getComment(db, 'r1')).toMatchObject({ parent_id: 'p1', parent_checked: 1, thread_id: 'p1' });
    // Sin parent_id en el payload: hay que confirmarlo leyendo el comentario (thread_id pendiente)
    expect(getComment(db, 't1')).toMatchObject({ parent_id: null, parent_checked: 0, thread_id: null });
  });

  it('guarda el payload crudo para depuración', () => {
    const { db, queue } = setup();
    queue.enqueueWebhookEvents([event('c1')], new Date(), Buffer.from('{"raw":true}'));
    expect(db.prepare('SELECT body, comment_ids FROM webhook_events').get()).toEqual({
      body: '{"raw":true}',
      comment_ids: '["c1"]',
    });
  });

  it('webhook duplicado de extremo a extremo: 2 POST → 1 fila → 1 procesamiento', async () => {
    const { db, queue, worker, processor } = setup();
    const app = await buildApp({
      logger,
      webhook: {
        appSecret: 's',
        verifyToken: 'v',
        enqueue: (events, ctx) => queue.enqueueWebhookEvents(events, ctx.receivedAt, ctx.rawBody),
      },
    });
    const body = JSON.stringify(
      buildCommentPayload({ commentId: 'c9', mediaId: 'm', text: 't', username: 'a', userId: '1' }),
    );
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhook/instagram',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': computeSignature(body, 's') },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
    await worker.drain();
    expect(processor).toHaveBeenCalledTimes(1);
    expect(countByStatus(db)).toEqual({ skipped: 1 });
  });
});

describe('worker', () => {
  it('procesa en orden de llegada y guarda el resultado', async () => {
    const seen: string[] = [];
    const { db, queue, worker } = setup(async (row) => {
      seen.push(row.comment_id);
      return { status: 'pending_review', decision: 'reply', patch: { reply_text: `@pepe ${row.comment_id}` } };
    });
    queue.enqueueWebhookEvents([event('a'), event('b'), event('c')], new Date());
    expect(await worker.drain()).toBe(3);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(getComment(db, 'b')).toMatchObject({
      status: 'pending_review',
      decision: 'reply',
      reply_text: '@pepe b',
      attempts: 1,
    });
  });

  it('si el procesador lanza, marca failed y sigue con el siguiente', async () => {
    const { db, queue, worker } = setup(async (row) => {
      if (row.comment_id === 'a') throw new Error('Claude caído');
      return { status: 'skipped', decision: 'test' };
    });
    queue.enqueueWebhookEvents([event('a'), event('b')], new Date());
    await worker.drain();
    expect(getComment(db, 'a')).toMatchObject({ status: 'failed', last_error: 'Claude caído' });
    expect(getComment(db, 'b')!.status).toBe('skipped');
  });

  it('al arrancar recupera los que quedaron a medias (processing → queued)', async () => {
    const { db, queue, worker, processor } = setup();
    queue.enqueueWebhookEvents([event('a')], new Date());
    queue.claimNext(); // simula un reinicio a mitad de proceso
    expect(getComment(db, 'a')!.status).toBe('processing');
    worker.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(1));
    await worker.stop();
    expect(getComment(db, 'a')!.status).toBe('skipped');
  });

  it('se despierta en cuanto se encola algo, sin esperar al polling', async () => {
    const db = openDb(':memory:');
    const queue = createCommentQueue(db);
    const processor = vi.fn<CommentProcessor>(async () => ({ status: 'skipped', decision: 't' }));
    const worker = createReplyWorker({ db, queue, processComment: processor, logger, pollIntervalMs: 60_000 });
    worker.start();
    await new Promise((r) => setTimeout(r, 20));
    queue.enqueueWebhookEvents([event('x')], new Date());
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(1), { timeout: 1000 });
    await worker.stop();
  });
});

describe('base de datos', () => {
  it('las migraciones son idempotentes (abrir dos veces el mismo fichero)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'igdb-'));
    const path = join(dir, 'sub', 'app.db');
    const a = openDb(path);
    a.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('k', '1', 1)").run();
    a.close();
    const b = openDb(path);
    expect(b.prepare('SELECT value FROM kv').get()).toEqual({ value: '1' });
    expect(b.pragma('journal_mode', { simple: true })).toBe('wal');
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
