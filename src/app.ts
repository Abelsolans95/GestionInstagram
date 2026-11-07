import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { DB } from './db/index.js';
import type { Logger } from './logger.js';
import type { ReplySettings } from './pipeline/replyStep.js';
import { requireToken } from './reports/auth.js';
import { reportRoutes } from './reports/routes.js';
import { reviewRoutes } from './review/routes.js';
import { webhookRoutes, type EnqueueFn } from './webhook/routes.js';

export interface AppDeps {
  logger: Logger;
  webhook: {
    appSecret: string;
    verifyToken: string;
    enqueue: EnqueueFn;
  };
  /** Informes protegidos con REPORT_TOKEN (opcional para tests del webhook). */
  reports?: { db: DB; reportToken: string };
  /** Página de revisión (mismo token que los informes). */
  review?: {
    db: DB;
    reportToken: string;
    settings: Pick<ReplySettings, 'delayMinSec' | 'delayMaxSec' | 'reviewMode'>;
    onRequeued?: () => void;
  };
  /** Estado del servicio en JSON (mismo token). */
  status?: { reportToken: string; get: () => Record<string, unknown> };
}

/** Construye la app HTTP sin arrancarla (los tests la usan con `app.inject`). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    // Railway (y ngrok) ponen un proxy delante.
    trustProxy: true,
  });

  app.get('/health', async () => ({ ok: true }));

  // URL de redirección para la configuración de Meta (login unificado). El servicio no usa el
  // flujo de login (el token se genera en el panel de Meta); esta página solo confirma la vuelta.
  app.get('/auth/callback', async (_req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('referrer-policy', 'no-referrer')
      .send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>Listo. Puedes cerrar esta ventana.</p>'),
  );

  await app.register(webhookRoutes, deps.webhook);
  if (deps.reports) await app.register(reportRoutes, deps.reports);
  if (deps.review) await app.register(reviewRoutes, deps.review);
  if (deps.status) {
    const status = deps.status;
    const db = deps.reports?.db;
    await app.register(async (scope) => {
      scope.addHook('onRequest', requireToken(status.reportToken));
      scope.get('/status', async () => {
        const counts = db
          ? Object.fromEntries(
              (db.prepare('SELECT status, COUNT(*) AS n FROM comments GROUP BY status').all() as { status: string; n: number }[]).map((r) => [r.status, r.n]),
            )
          : {};
        return { ...status.get(), comments: counts };
      });
    });
  }

  return app;
}
