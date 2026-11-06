import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import type { CommentEvent } from '../src/webhook/parse.js';
import type { EnqueueFn } from '../src/webhook/routes.js';
import { computeSignature } from '../src/webhook/signature.js';
import { buildCommentPayload } from '../scripts/payload.js';

const SECRET = 'secreto-test';
const VERIFY = 'verify-token-test';

let app: FastifyInstance;
let enqueue: ReturnType<typeof vi.fn<EnqueueFn>>;

beforeEach(async () => {
  enqueue = vi.fn<EnqueueFn>();
  app = await buildApp({
    logger: createLogger('silent'),
    webhook: { appSecret: SECRET, verifyToken: VERIFY, enqueue },
  });
});

afterEach(async () => {
  await app.close();
});

function post(body: string, signature?: string) {
  return app.inject({
    method: 'POST',
    url: '/webhook/instagram',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    payload: body,
  });
}

const sample = JSON.stringify(
  buildCommentPayload({
    commentId: '18000000000000010',
    mediaId: '17900000000000001',
    text: 'Yo quiero broooo🔥🔥🙌',
    username: 'incognito_dvc',
    userId: '42',
  }),
);

describe('GET /webhook/instagram (handshake)', () => {
  it('devuelve hub.challenge tal cual si el verify token coincide', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/webhook/instagram?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('403 si el verify token no coincide', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhook/instagram?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1',
    });
    expect(res.statusCode).toBe(403);
  });

  it('403 si hub.mode no es subscribe o falta el challenge', async () => {
    const a = await app.inject({
      method: 'GET',
      url: `/webhook/instagram?hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`,
    });
    const b = await app.inject({
      method: 'GET',
      url: `/webhook/instagram?hub.mode=subscribe&hub.verify_token=${VERIFY}`,
    });
    expect(a.statusCode).toBe(403);
    expect(b.statusCode).toBe(403);
  });
});

describe('POST /webhook/instagram', () => {
  it('con firma válida: encola los comentarios y responde 200', async () => {
    const res = await post(sample, computeSignature(sample, SECRET));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('EVENT_RECEIVED');
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [events, ctx] = enqueue.mock.calls[0]!;
    expect((events as CommentEvent[]).map((e) => e.commentId)).toEqual(['18000000000000010']);
    expect(ctx.rawBody.toString()).toBe(sample);
  });

  it('solo encola: no espera a ningún procesamiento', async () => {
    // El sumidero es síncrono y la ruta no hace nada más que llamarlo.
    let finished = false;
    enqueue.mockImplementation(() => {
      setTimeout(() => {
        finished = true;
      }, 50);
    });
    const res = await post(sample, computeSignature(sample, SECRET));
    expect(res.statusCode).toBe(200);
    expect(finished).toBe(false);
  });

  it('401 sin firma o con firma inválida, y no encola nada', async () => {
    expect((await post(sample)).statusCode).toBe(401);
    expect((await post(sample, computeSignature(sample, 'otro'))).statusCode).toBe(401);
    expect((await post(sample, computeSignature(sample + ' ', SECRET))).statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 si el cuerpo firmado no es JSON', async () => {
    const res = await post('no-json', computeSignature('no-json', SECRET));
    expect(res.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('200 sin encolar nada si el payload no trae comentarios', async () => {
    const body = JSON.stringify({ object: 'instagram', entry: [] });
    const res = await post(body, computeSignature(body, SECRET));
    expect(res.statusCode).toBe(200);
    expect(enqueue.mock.calls[0]![0]).toEqual([]);
  });

  it('500 si no se puede encolar, para que Meta reintente', async () => {
    enqueue.mockImplementation(() => {
      throw new Error('disco lleno');
    });
    const res = await post(sample, computeSignature(sample, SECRET));
    expect(res.statusCode).toBe(500);
  });

  it('los duplicados se encolan igual (la deduplicación la hace la cola, fase b)', async () => {
    const sig = computeSignature(sample, SECRET);
    await post(sample, sig);
    await post(sample, sig);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

describe('GET /health', () => {
  it('responde ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true });
  });
});
