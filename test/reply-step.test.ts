import { describe, expect, it } from 'vitest';
import { getComment, insertCommentIfNew, updateComment } from '../src/db/comments.js';
import { openDb } from '../src/db/index.js';
import { LlmRefusalError } from '../src/llm/claude.js';
import { createCommentProcessor } from '../src/pipeline/processComment.js';
import { createReplyStep, type ReplySettings } from '../src/pipeline/replyStep.js';
import { createCommentQueue } from '../src/queue/commentQueue.js';
import { createCoreServices } from '../src/services.js';
import type { CommentEvent } from '../src/webhook/parse.js';
import { createReplyWorker } from '../src/worker/replyWorker.js';
import { createFakeMeta } from './helpers/fakeMeta.js';
import { commentTextOf, fakeLlm, IG_USER_ID, OWN_USERNAME, silentLogger, testConfig, testLists, testPrompts } from './helpers/fakes.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const MEDIA = [{ id: 'm1', caption: 'Día 1: ¿qué oficio quieres?', permalink: 'p', shortcode: 'AAA', timestamp: '2026-11-01T10:00:00+0000', media_type: 'VIDEO', owner: { id: IG_USER_ID } }];

/** El "modelo" responde según el texto del comentario. */
function replyFor(text: string): unknown {
  if (text.includes('herramientas')) return { reply: 'genial!! un herrero hacía falta 🔥', reason: 'se apunta' };
  if (text.includes('broooo')) return { reply: '@incognito_dvc 🔥🔥🔥', reason: 'hype' };
  if (text.includes('🔥🔥🔥')) return { reply: '🙌🙌', reason: 'solo emojis' };
  if (text.includes('siguiente')) return { reply: '@usuario eso no te lo puedo decir 👀 ¿tú qué harías?', reason: 'spoiler' };
  if (text.includes('rollo')) return { reply: null, reason: 'polémica' };
  if (text.includes('largo')) return { reply: 'x'.repeat(250), reason: 'largo' };
  if (text.includes('roto')) return 'esto no es json';
  if (text.includes('rechazo')) return new LlmRefusalError('general_harms');
  return { reply: 'jajaja', reason: 'otro' };
}

function setup(settings: Partial<ReplySettings> = {}) {
  const meta = createFakeMeta({
    igUserId: IG_USER_ID, username: OWN_USERNAME, media: MEDIA, threads: {},
    comments: [{ id: 'principal', text: 'Yo quiero broooo🔥🔥🙌', username: 'incognito_dvc', timestamp: '2026-11-06T11:59:00+0000', from: { id: 'ig-u', username: 'incognito_dvc' } }],
  });
  const { llm, calls } = fakeLlm((req) => {
    if (req.task === 'question') return { question: '¿qué oficio quieres?' };
    if (req.task === 'extract') return { answers_question: false, answer: null, answer_label: null, character_name: null };
    return replyFor(commentTextOf(req) || /Comentario de @[^:]*:\n"""([\s\S]*?)"""/.exec(req.user)?.[1] || '');
  });
  const db = openDb(':memory:');
  const config = testConfig({ reviewMode: true, ...settings });
  const s = createCoreServices(config, silentLogger, { db, fetch: meta.fetch, llm, prompts: testPrompts, lists: testLists, sleep: async () => {} });
  const replyStep = createReplyStep({
    db, llm, prompts: testPrompts, lists: testLists, logger: silentLogger,
    settings: { ...config.replies }, now: () => NOW, random: () => 0.5,
  });
  const queue = createCommentQueue(db);
  const worker = createReplyWorker({ db, queue, processComment: createCommentProcessor({ ...s.analysis, replyStep, now: () => NOW }), logger: silentLogger });
  let n = 0;
  const send = async (text: string, extra: Partial<CommentEvent> = {}) => {
    const id = extra.commentId ?? `c${++n}`;
    queue.enqueueWebhookEvents(
      [{ commentId: id, mediaId: 'm1', text, fromId: 'ig-u', fromUsername: 'incognito_dvc', parentId: 'TOP', mediaProductType: 'REELS', accountId: IG_USER_ID, sentAt: null, ...extra }],
      new Date(NOW),
    );
    await worker.drain();
    return getComment(db, id)!;
  };
  return { db, send, calls, meta };
}

describe('respuesta con Claude', () => {
  it('REVIEW_MODE=true: guarda la respuesta como pendiente, sin programarla', async () => {
    const { send, meta } = setup({ reviewMode: true });
    const row = await send('Yo quiero ser el que haga las herramientas', { fromUsername: 'cesar_h_marquez' });
    expect(row).toMatchObject({
      status: 'pending_review',
      decision: 'reply',
      reply_text: '@cesar_h_marquez genial!! un herrero hacía falta 🔥',
      reply_target_id: 'TOP',
      publish_at: null,
    });
    expect(meta.posts()).toEqual([]);
  });

  it('REVIEW_MODE=false: queda programada con un delay aleatorio entre MIN y MAX', async () => {
    const { send } = setup({ reviewMode: false, delayMinSec: 60, delayMaxSec: 300 });
    const row = await send('Yo quiero broooo🔥🔥🙌');
    expect(row.status).toBe('scheduled');
    expect(row.publish_at).toBe(NOW + 180_000); // random=0.5 → 60 + 0.5·240 s
  });

  it('en una respuesta dentro de un hilo se publica sobre el comentario padre', async () => {
    const { send } = setup();
    expect((await send('Yo quiero broooo🔥🔥🙌', { parentId: 'PADRE' })).reply_target_id).toBe('PADRE');
  });

  it('en un comentario principal se publica sobre el propio comentario', async () => {
    const { send, meta } = setup();
    // Sin parent_id en el payload: el worker lee el comentario (GET) y ve que es principal.
    const row = await send('Yo quiero broooo🔥🔥🙌', { commentId: 'principal', parentId: null });
    expect(row).toMatchObject({ status: 'pending_review', parent_id: null, thread_id: 'principal', reply_target_id: 'principal' });
    expect(meta.calls.some((c) => c.method === 'GET' && c.path === '/principal')).toBe(true);
  });

  it('los comentarios de solo emojis SÍ se responden', async () => {
    const { send } = setup();
    expect(await send('🔥🔥🔥')).toMatchObject({ status: 'pending_review', reply_text: '@incognito_dvc 🙌🙌' });
  });

  it('corrige la mención si el modelo copia la de un ejemplo', async () => {
    const { send } = setup();
    expect((await send('y qué pasa en el siguiente??')).reply_text).toBe('@incognito_dvc eso no te lo puedo decir 👀 ¿tú qué harías?');
  });

  it('reply null → no responde (pero el comentario se analiza igual)', async () => {
    const { send } = setup();
    expect(await send('menudo rollo')).toMatchObject({ status: 'skipped', decision: 'llm_null', extract_status: 'done' });
  });

  it('salida demasiado larga o JSON inválido → se descarta', async () => {
    const { send } = setup();
    expect(await send('algo largo')).toMatchObject({ status: 'skipped', decision: 'invalid_llm_output', reason: 'salida descartada: too_long' });
    expect(await send('algo roto')).toMatchObject({ status: 'skipped', decision: 'invalid_llm_output', reason: 'salida descartada: json_invalid' });
  });

  it('si el modelo se niega, no responde', async () => {
    const { send } = setup();
    expect(await send('rechazo')).toMatchObject({ status: 'skipped', decision: 'llm_refusal' });
  });
});

describe('filtros de respuesta (la extracción se hace igual)', () => {
  it('con enlaces: no responde, sí analiza', async () => {
    const { send, calls } = setup();
    const row = await send('mira mi tienda www.tienda.com 🔥');
    expect(row).toMatchObject({ status: 'skipped', decision: 'has_link', extract_status: 'done' });
    expect(calls.filter((c) => c.task === 'reply')).toHaveLength(0);
  });

  it('con un término bloqueado: no responde, sí analiza', async () => {
    const { send } = setup();
    expect(await send('eres un gilipollas')).toMatchObject({ status: 'skipped', decision: 'blocked_term', extract_status: 'done' });
  });

  it('máximo 2 respuestas automáticas al mismo usuario en el mismo hilo en 24 h', async () => {
    const { send } = setup();
    expect((await send('Yo quiero broooo🔥🔥🙌', { parentId: 'T' })).status).toBe('pending_review');
    expect((await send('Yo quiero broooo🔥🔥🙌 otra', { parentId: 'T' })).status).toBe('pending_review');
    expect(await send('Yo quiero broooo🔥🔥🙌 y otra', { parentId: 'T' })).toMatchObject({ status: 'skipped', decision: 'thread_limit', extract_status: 'done' });
    // en otro hilo sí
    expect((await send('Yo quiero broooo🔥🔥🙌', { parentId: 'OTRO' })).status).toBe('pending_review');
    // otro usuario en el mismo hilo, sí
    expect((await send('Yo quiero broooo🔥🔥🙌', { parentId: 'T', fromUsername: 'ana', fromId: 'ig-ana' })).status).toBe('pending_review');
  });

  it('las respuestas rechazadas no cuentan para el límite del hilo', async () => {
    const { send, db } = setup();
    const a = await send('Yo quiero broooo🔥🔥🙌', { parentId: 'T' });
    const b = await send('Yo quiero broooo🔥🔥🙌 2', { parentId: 'T' });
    updateComment(db, a.comment_id, { status: 'rejected' });
    updateComment(db, b.comment_id, { status: 'rejected' });
    expect((await send('Yo quiero broooo🔥🔥🙌 3', { parentId: 'T' })).status).toBe('pending_review');
  });

  it('MAX_REPLY_AGE_HOURS: no responde comentarios demasiado antiguos (0 = responde todos)', async () => {
    const db = openDb(':memory:');
    const { llm, calls } = fakeLlm(() => ({ reply: '🔥', reason: 'x' }));
    const ctx = (hoursAgo: number) => ({
      row: { comment_id: `c${hoursAgo}`, media_id: 'm1', username: 'pepe', text: 'hola', commented_at: NOW - hoursAgo * 3_600_000, source: 'webhook', status: 'processing' } as never,
      media: { mediaId: 'm1', caption: null, permalink: null, shortcode: null, isOwn: true, question: null, questionSource: null },
      threadId: `c${hoursAgo}`, parentId: null, parent: null, hidden: false, label: null, extractError: null,
    });
    const step = (maxAgeHours: number) =>
      createReplyStep({ db, llm, prompts: testPrompts, lists: testLists, logger: silentLogger, settings: { delayMinSec: 60, delayMaxSec: 300, reviewMode: true, maxAgeHours }, now: () => NOW });
    expect(await step(48)(ctx(72))).toMatchObject({ status: 'skipped', decision: 'too_old' });
    expect(await step(48)(ctx(1))).toMatchObject({ status: 'pending_review' });
    expect(await step(0)(ctx(24 * 30))).toMatchObject({ status: 'pending_review' });
    expect(calls).toHaveLength(2);
  });

  it('comentario oculto: Meta no permite responderlo', async () => {
    const db = openDb(':memory:');
    const { llm } = fakeLlm(() => ({ reply: '🔥', reason: 'x' }));
    const step = createReplyStep({ db, llm, prompts: testPrompts, lists: testLists, logger: silentLogger, settings: { delayMinSec: 1, delayMaxSec: 2, reviewMode: true, maxAgeHours: 0 } });
    const out = await step({
      row: { comment_id: 'h', username: 'pepe', text: 'hola', commented_at: Date.now(), source: 'webhook', status: 'processing' } as never,
      media: { mediaId: 'm1', caption: null, permalink: null, shortcode: null, isOwn: true, question: null, questionSource: null },
      threadId: 'h', parentId: null, parent: null, hidden: true, label: null, extractError: null,
    });
    expect(out).toMatchObject({ status: 'skipped', decision: 'hidden' });
  });
});
