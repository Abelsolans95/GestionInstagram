import './env.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { createLogger } from './logger.js';
import { createCommentQueue, pruneWebhookEvents } from './queue/commentQueue.js';
import { createReplyWorker, type CommentProcessor } from './worker/replyWorker.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = openDb(config.databasePath);
  const queue = createCommentQueue(db);

  // Fase (b): el pipeline (extracción → filtros → respuesta) llega en las fases c y e.
  const processComment: CommentProcessor = async () => ({
    status: 'skipped',
    decision: 'pipeline_pendiente',
    reason: 'el pipeline se implementa en las fases c y e',
  });

  const worker = createReplyWorker({ db, queue, processComment, logger });

  const app = await buildApp({
    logger,
    webhook: {
      appSecret: config.webhook.appSecret,
      verifyToken: config.webhook.verifyToken,
      enqueue: (events, ctx) => queue.enqueueWebhookEvents(events, ctx.receivedAt, ctx.rawBody),
    },
  });

  const prune = () => {
    const n = pruneWebhookEvents(db, 30 * DAY_MS);
    if (n) logger.info({ removed: n }, 'eventos de webhook antiguos borrados');
  };
  prune();
  const pruneTimer = setInterval(prune, DAY_MS);
  pruneTimer.unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'apagando');
    await app.close();
    await worker.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  worker.start();
  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
