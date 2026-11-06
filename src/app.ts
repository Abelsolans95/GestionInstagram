import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { DB } from './db/index.js';
import type { Logger } from './logger.js';
import { reportRoutes } from './reports/routes.js';
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
}

/** Construye la app HTTP sin arrancarla (los tests la usan con `app.inject`). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    // Railway (y ngrok) ponen un proxy delante.
    trustProxy: true,
  });

  app.get('/health', async () => ({ ok: true }));

  await app.register(webhookRoutes, deps.webhook);
  if (deps.reports) await app.register(reportRoutes, deps.reports);

  return app;
}
