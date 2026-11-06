import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from './logger.js';
import { webhookRoutes, type EnqueueFn } from './webhook/routes.js';

export interface AppDeps {
  logger: Logger;
  webhook: {
    appSecret: string;
    verifyToken: string;
    enqueue: EnqueueFn;
  };
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

  return app;
}
