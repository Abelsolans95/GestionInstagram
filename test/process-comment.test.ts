import { describe, expect, it, vi } from 'vitest';
import { getComment } from '../src/db/comments.js';
import { openDb } from '../src/db/index.js';
import { createCommentProcessor, type ReplyStep, type ReplyStepContext } from '../src/pipeline/processComment.js';
import { createCommentQueue } from '../src/queue/commentQueue.js';
import { createCoreServices } from '../src/services.js';
import type { CommentEvent } from '../src/webhook/parse.js';
import { createReplyWorker } from '../src/worker/replyWorker.js';
import { createFakeMeta } from './helpers/fakeMeta.js';
import { commentTextOf, fakeLlm, IG_USER_ID, OWN_USERNAME, silentLogger, testConfig, testLists, testPrompts } from './helpers/fakes.js';

const MEDIA = [
  { id: 'm1', caption: 'Día 1: ¿qué oficio quieres?', permalink: 'p1', shortcode: 'AAA', timestamp: '2026-10-01T10:00:00+0000', media_type: 'VIDEO', owner: { id: IG_USER_ID } },
  { id: 'otro', caption: 'vídeo ajeno', permalink: 'p2', shortcode: 'ZZZ', timestamp: '2026-10-01T10:00:00+0000', media_type: 'VIDEO', username: 'otra_cuenta' },
];
const COMMENTS = [
  { id: 'top', text: '¿Y quién hará el pan?', username: 'ana', timestamp: '2026-10-01T11:00:00+0000', from: { id: 'ig-ana', username: 'ana' } },
  { id: 'rep', text: 'Yo quiero ser panadero', username: 'pepe', timestamp: '2026-10-01T11:05:00+0000', from: { id: 'ig-pepe', username: 'pepe' }, parent_id: 'top' },
  { id: 'solo', text: 'Yo quiero ser el que haga las herramientas', username: 'cesar', timestamp: '2026-10-01T11:06:00+0000', from: { id: 'ig-cesar', username: 'cesar' } },
];

function ev(id: string, extra: Partial<CommentEvent> = {}): CommentEvent {
  const c = COMMENTS.find((x) => x.id === id);
  return {
    commentId: id,
    mediaId: 'm1',
    text: c?.text ?? 'hola',
    fromId: c?.from.id ?? 'ig-x',
    fromUsername: c?.username ?? 'x',
    parentId: null,
    mediaProductType: 'REELS',
    accountId: IG_USER_ID,
    sentAt: 1,
    ...extra,
  };
}

function setup(llmHandler?: Parameters<typeof fakeLlm>[0]) {
  const meta = createFakeMeta({ igUserId: IG_USER_ID, username: OWN_USERNAME, media: MEDIA, threads: {}, comments: COMMENTS });
  const { llm, calls } = fakeLlm(
    llmHandler ??
      ((req) => {
        if (req.task === 'question') return { question: '¿qué oficio quieres?' };
        const t = commentTextOf(req);
        if (t.includes('panadero')) return { answers_question: true, answer: 'panadero', answer_label: 'panadero', character_name: null };
        if (t.includes('herramientas')) return { answers_question: true, answer: 'herramientas', answer_label: 'herrero', character_name: null };
        return { answers_question: false, answer: null, answer_label: null, character_name: null };
      }),
  );
  const db = openDb(':memory:');
  const s = createCoreServices(testConfig(), silentLogger, { db, fetch: meta.fetch, llm, prompts: testPrompts, lists: testLists, sleep: async () => {} });
  const replyStep = vi.fn<ReplyStep>(async () => ({ status: 'pending_review', decision: 'reply', patch: { reply_text: '@x 🔥' } }));
  const queue = createCommentQueue(db);
  const worker = createReplyWorker({ db, queue, processComment: createCommentProcessor({ ...s.analysis, replyStep }), logger: silentLogger });
  return { db, meta, calls, replyStep, queue, worker };
}

describe('procesador del worker (extracción → filtros → respuesta)', () => {
  it('comentario normal: extrae, guarda la respuesta a la pregunta y pasa a la respuesta', async () => {
    const { db, queue, worker, replyStep, meta } = setup();
    queue.enqueueWebhookEvents([ev('solo')], new Date());
    await worker.drain();
    expect(getComment(db, 'solo')).toMatchObject({ status: 'pending_review', answer_label: 'herrero', extract_status: 'done', thread_id: 'solo', parent_checked: 1 });
    expect(replyStep).toHaveBeenCalledTimes(1);
    expect(replyStep.mock.calls[0]![0]).toMatchObject({ threadId: 'solo', parentId: null, label: 'herrero' });
    expect(meta.posts()).toEqual([]);
  });

  it('sin parent_id en el payload, lee el comentario y descubre que es una respuesta en un hilo', async () => {
    const { db, queue, worker, replyStep } = setup();
    queue.enqueueWebhookEvents([ev('rep')], new Date());
    await worker.drain();
    expect(getComment(db, 'rep')).toMatchObject({ parent_id: 'top', thread_id: 'top', parent_checked: 1 });
    const ctx = replyStep.mock.calls[0]![0] as ReplyStepContext;
    expect(ctx.parentId).toBe('top');
    expect(ctx.parent).toEqual({ username: 'ana', text: '¿Y quién hará el pan?' });
  });

  it('con parent_id en el payload no hace falta leer el comentario', async () => {
    const { queue, worker, meta } = setup();
    queue.enqueueWebhookEvents([ev('rep', { parentId: 'top' })], new Date());
    await worker.drain();
    expect(meta.calls.some((c) => c.path === '/rep')).toBe(false);
  });

  it('comentario propio (por IG_USER_ID): ni extracción ni respuesta', async () => {
    const { db, queue, worker, replyStep, calls } = setup();
    queue.enqueueWebhookEvents([ev('x1', { fromId: IG_USER_ID, fromUsername: OWN_USERNAME, parentId: 'top' })], new Date());
    await worker.drain();
    expect(getComment(db, 'x1')).toMatchObject({ status: 'skipped', decision: 'own_comment', extract_status: 'skipped' });
    expect(replyStep).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.task === 'extract')).toHaveLength(0);
  });

  it('comentario propio (por username, aunque el id no coincida)', async () => {
    const { db, queue, worker } = setup();
    queue.enqueueWebhookEvents([ev('x2', { fromId: 'otro-id', fromUsername: 'HumanidadDesdeCero', parentId: 'top' })], new Date());
    await worker.drain();
    expect(getComment(db, 'x2')!.decision).toBe('own_comment');
  });

  it('spam: ni extracción ni respuesta', async () => {
    const { db, queue, worker, replyStep, calls } = setup();
    queue.enqueueWebhookEvents([ev('s1', { text: 'Gana dinero fácil, mira mi perfil', parentId: 'top' })], new Date());
    await worker.drain();
    expect(getComment(db, 's1')).toMatchObject({ status: 'skipped', decision: 'spam' });
    expect(replyStep).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.task === 'extract')).toHaveLength(0);
  });

  it('comentario en un vídeo que no es tuyo (mención): se ignora', async () => {
    const { db, queue, worker, replyStep } = setup();
    queue.enqueueWebhookEvents([ev('solo', { mediaId: 'otro' })], new Date());
    await worker.drain();
    expect(getComment(db, 'solo')).toMatchObject({ status: 'skipped', decision: 'not_own_media' });
    expect(replyStep).not.toHaveBeenCalled();
  });

  it('si la extracción falla, se registra y la respuesta sigue adelante', async () => {
    const { db, queue, worker, replyStep } = setup((req) => (req.task === 'question' ? { question: null } : 'json roto'));
    queue.enqueueWebhookEvents([ev('solo')], new Date());
    await worker.drain();
    expect(replyStep).toHaveBeenCalledTimes(1);
    expect(getComment(db, 'solo')).toMatchObject({ status: 'pending_review', extract_status: 'failed' });
    expect(getComment(db, 'solo')!.last_error).toContain('extracción');
  });

  it('la pregunta del vídeo se detecta una sola vez y queda cacheada por media', async () => {
    const { queue, worker, calls, meta } = setup();
    queue.enqueueWebhookEvents([ev('solo'), ev('rep', { parentId: 'top' })], new Date());
    await worker.drain();
    expect(calls.filter((c) => c.task === 'question')).toHaveLength(1);
    expect(meta.calls.filter((c) => c.path === '/m1')).toHaveLength(1);
  });
});
