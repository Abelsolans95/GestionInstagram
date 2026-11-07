import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { getComment, insertCommentIfNew, updateComment } from '../src/db/comments.js';
import { openDb, type DB } from '../src/db/index.js';
import { approve, countRetryableFailed, editReply, listPending, reject, retryAllFailed, retryFailed, ReviewError } from '../src/review/reviewService.js';
import { silentLogger } from './helpers/fakes.js';

const TOKEN = 'report-token-0123456789';
const settings = { delayMinSec: 60, delayMaxSec: 300, reviewMode: true };

let db: DB;

function pendingReply(id: string, username = 'pepe', reply = `@${username} 🔥🔥`) {
  insertCommentIfNew(db, { commentId: id, mediaId: 'm1', parentId: null, parentChecked: true, igUserId: null, username, text: 'Yo quiero broooo', commentedAt: 1, source: 'webhook', status: 'queued' });
  updateComment(db, id, { status: 'pending_review', reply_text: reply, reply_reason: 'hype', reply_target_id: id });
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('servicio de revisión', () => {
  it('lista las pendientes', () => {
    pendingReply('a');
    pendingReply('b');
    expect(listPending(db).map((c) => c.comment_id)).toEqual(['a', 'b']);
  });

  it('editar valida igual que la salida del modelo (añade @usuario, máx. 200, sin enlaces)', () => {
    pendingReply('a');
    expect(editReply(db, 'a', 'jajaja lo vemos más adelante!!')).toBe('@pepe jajaja lo vemos más adelante!!');
    expect(getComment(db, 'a')!.reply_text).toBe('@pepe jajaja lo vemos más adelante!!');
    expect(() => editReply(db, 'a', 'x'.repeat(250))).toThrow(ReviewError);
    expect(() => editReply(db, 'a', 'mira bit.ly/x')).toThrow(/enlaces/);
    expect(() => editReply(db, 'a', '@pepe')).toThrow(/vacía/);
  });

  it('aprobar la programa con el delay aleatorio', () => {
    pendingReply('a');
    const row = approve(db, 'a', settings, { now: 1_000_000, random: () => 0 });
    expect(row).toMatchObject({ status: 'scheduled', publish_at: 1_000_000 + 60_000, reply_text: '@pepe 🔥🔥' });
  });

  it('aprobar con texto nuevo lo edita antes', () => {
    pendingReply('a');
    expect(approve(db, 'a', settings, { text: 'genial!!' }).reply_text).toBe('@pepe genial!!');
  });

  it('rechazar', () => {
    pendingReply('a');
    reject(db, 'a');
    expect(getComment(db, 'a')!.status).toBe('rejected');
  });

  it('no deja aprobar/rechazar lo que no está pendiente', () => {
    pendingReply('a');
    approve(db, 'a', settings);
    expect(() => approve(db, 'a', settings)).toThrow(/no está pendiente/);
    expect(() => reject(db, 'nada')).toThrow(/No existe/);
  });

  it('reintentar un fallido lo devuelve a la cola, pero nunca uno importado', () => {
    insertCommentIfNew(db, { commentId: 'f', mediaId: 'm1', parentId: null, parentChecked: true, igUserId: null, username: 'u', text: 't', commentedAt: 1, source: 'webhook', status: 'queued' });
    updateComment(db, 'f', { status: 'failed', attempts: 1, last_error: 'boom' });
    retryFailed(db, 'f');
    expect(getComment(db, 'f')).toMatchObject({ status: 'queued', attempts: 0, last_error: null });

    insertCommentIfNew(db, { commentId: 'i', mediaId: 'm1', parentId: null, parentChecked: true, igUserId: null, username: 'u', text: 't', commentedAt: 1, source: 'import', status: 'imported' });
    updateComment(db, 'i', { status: 'failed' });
    expect(() => retryFailed(db, 'i')).toThrow(/importados/);
  });
});

describe('reintentar todos los fallidos', () => {
  it('vuelve a encolar los fallidos de webhook/poll, nunca los importados', () => {
    for (const [id, source] of [['w1', 'webhook'], ['w2', 'poll'], ['i1', 'import']] as const) {
      insertCommentIfNew(db, { commentId: id, mediaId: 'm1', parentId: null, parentChecked: true, igUserId: null, username: 'u', text: 't', commentedAt: 1, source, status: source === 'import' ? 'imported' : 'queued' });
      updateComment(db, id, { status: 'failed', last_error: 'clave mal' });
    }
    expect(countRetryableFailed(db)).toBe(2);
    expect(retryAllFailed(db)).toBe(2);
    expect(getComment(db, 'w1')).toMatchObject({ status: 'queued', last_error: null });
    expect(getComment(db, 'i1')!.status).toBe('failed');
  });
});

describe('página de revisión para el móvil', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp({
      logger: silentLogger,
      webhook: { appSecret: 's', verifyToken: 'v', enqueue: () => {} },
      review: { db, reportToken: TOKEN, settings },
    });
  });
  afterEach(async () => {
    await app.close();
  });

  const form = (url: string, body: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body).toString() });

  it('pide el token', async () => {
    expect((await app.inject({ method: 'GET', url: '/review' })).statusCode).toBe(401);
    expect((await form('/review/a/approve')).statusCode).toBe(401);
  });

  it('muestra las pendientes con su texto editable', async () => {
    pendingReply('a', 'pepe', '@pepe <b>🔥</b>');
    const res = await app.inject({ method: 'GET', url: `/review?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Respuestas pendientes (1)');
    expect(res.body).toContain('&lt;b&gt;🔥&lt;/b&gt;</textarea>');
    expect(res.body).toContain(`/review/a/approve?token=${TOKEN}`);
  });

  it('aprobar desde el formulario (con edición) programa la respuesta y vuelve a la lista', async () => {
    pendingReply('a');
    const res = await form(`/review/a/approve?token=${TOKEN}`, { reply_text: 'a ver cuándo hay pelotas!!!' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain('/review?token=');
    expect(getComment(db, 'a')).toMatchObject({ status: 'scheduled', reply_text: '@pepe a ver cuándo hay pelotas!!!' });
  });

  it('un texto inválido no se aprueba y se avisa', async () => {
    pendingReply('a');
    const res = await form(`/review/a/approve?token=${TOKEN}`, { reply_text: 'x'.repeat(300) });
    expect(res.statusCode).toBe(303);
    expect(decodeURIComponent(String(res.headers.location))).toContain('supera 200');
    expect(getComment(db, 'a')!.status).toBe('pending_review');
  });

  it('botón para reintentar los fallidos', async () => {
    insertCommentIfNew(db, { commentId: 'f1', mediaId: 'm1', parentId: null, parentChecked: true, igUserId: null, username: 'u', text: 't', commentedAt: 1, source: 'webhook', status: 'queued' });
    updateComment(db, 'f1', { status: 'failed' });
    const page = await app.inject({ method: 'GET', url: `/review?token=${TOKEN}` });
    expect(page.body).toContain('Reintentar 1 comentario fallido');
    const res = await form(`/review/retry-failed?token=${TOKEN}`);
    expect(res.statusCode).toBe(303);
    expect(getComment(db, 'f1')!.status).toBe('queued');
  });

  it('rechazar y aprobar todas', async () => {
    pendingReply('a');
    pendingReply('b');
    pendingReply('c');
    await form(`/review/a/reject?token=${TOKEN}`);
    expect(getComment(db, 'a')!.status).toBe('rejected');
    await form(`/review/approve-all?token=${TOKEN}`);
    expect([getComment(db, 'b')!.status, getComment(db, 'c')!.status]).toEqual(['scheduled', 'scheduled']);
  });
});
