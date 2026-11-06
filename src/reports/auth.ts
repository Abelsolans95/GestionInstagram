import type { FastifyReply, FastifyRequest } from 'fastify';
import { safeEqual } from '../webhook/signature.js';

/** Token de los informes: ?token=... (cómodo para guardar el enlace en el móvil) o Authorization: Bearer. */
export function requestToken(req: FastifyRequest): string | undefined {
  const q = (req.query as Record<string, string | undefined>).token;
  if (q) return q;
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body.token === 'string') return body.token;
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

export function requireToken(expected: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!safeEqual(requestToken(req), expected)) {
      return reply.code(401).type('text/plain').send('Unauthorized');
    }
    // Las páginas llevan datos de seguidores: que no se cacheen ni se filtre el token al pinchar enlaces.
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
  };
}
