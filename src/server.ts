import './env.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import type { EnqueueFn } from './webhook/routes.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // Fase (a): todavía no hay cola persistente; solo registramos lo que llegaría a encolarse.
  // En la fase (b) se sustituye por la cola SQLite + worker.
  const enqueue: EnqueueFn = (events) => {
    for (const e of events) {
      logger.info(
        {
          comment_id: e.commentId,
          username: e.fromUsername,
          media_id: e.mediaId,
          parent_id: e.parentId,
          origin: 'webhook',
        },
        'comentario recibido (cola pendiente de implementar en la fase b)',
      );
    }
  };

  const app = await buildApp({
    logger,
    webhook: {
      appSecret: config.webhook.appSecret,
      verifyToken: config.webhook.verifyToken,
      enqueue,
    },
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'apagando');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
