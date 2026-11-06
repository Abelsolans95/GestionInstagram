import type { FastifyPluginAsync } from 'fastify';
import type { EnqueueResult } from '../queue/commentQueue.js';
import { parseWebhookPayload, type CommentEvent } from './parse.js';
import { SIGNATURE_HEADER, safeEqual, verifySignature } from './signature.js';

export const WEBHOOK_PATH = '/webhook/instagram';

export interface EnqueueContext {
  receivedAt: Date;
  rawBody: Buffer;
}

/**
 * Sumidero de eventos: solo debe ENCOLAR (escritura rápida y síncrona), nunca procesar.
 * Si lanza una excepción respondemos 500 para que Meta reintente la entrega.
 */
export type EnqueueFn = (events: CommentEvent[], ctx: EnqueueContext) => EnqueueResult | void;

export interface WebhookOptions {
  appSecret: string;
  verifyToken: string;
  enqueue: EnqueueFn;
}

const MAX_BODY_BYTES = 1024 * 1024;

export const webhookRoutes: FastifyPluginAsync<WebhookOptions> = async (app, opts) => {
  // Necesitamos el cuerpo crudo para validar la firma. Este parser solo afecta a las rutas
  // de este plugin (Fastify encapsula los content-type parsers por contexto).
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES },
    (_req, body, done) => done(null, body),
  );

  // Handshake de verificación: Meta envía hub.mode=subscribe, hub.verify_token y hub.challenge.
  app.get(WEBHOOK_PATH, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const mode = q['hub.mode'];
    const challenge = q['hub.challenge'];
    if (mode === 'subscribe' && challenge && safeEqual(q['hub.verify_token'], opts.verifyToken)) {
      req.log.info('webhook verificado por Meta');
      return reply.code(200).type('text/plain').send(challenge);
    }
    req.log.warn({ mode }, 'handshake de webhook rechazado');
    return reply.code(403).type('text/plain').send('Forbidden');
  });

  // Notificaciones: validar firma → encolar → 200 inmediato. Nunca se procesa aquí.
  app.post(WEBHOOK_PATH, async (req, reply) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) {
      return reply.code(400).type('text/plain').send('Bad Request');
    }
    if (!verifySignature(raw, req.headers[SIGNATURE_HEADER], opts.appSecret)) {
      req.log.warn({ bytes: raw.length }, 'firma X-Hub-Signature-256 inválida');
      return reply.code(401).type('text/plain').send('Invalid signature');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      req.log.warn('cuerpo del webhook no es JSON válido');
      return reply.code(400).type('text/plain').send('Bad Request');
    }

    const { comments, ignored } = parseWebhookPayload(payload);
    const result = opts.enqueue(comments, { receivedAt: new Date(), rawBody: raw });
    req.log.info(
      {
        comments: comments.map((c) => c.commentId),
        duplicates: result && result.duplicates.length ? result.duplicates : undefined,
        ignored: ignored.length ? ignored : undefined,
      },
      'webhook recibido y encolado',
    );
    return reply.code(200).type('text/plain').send('EVENT_RECEIVED');
  });
};
