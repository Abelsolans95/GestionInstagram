import './env.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createCommentProcessor, pendingReplyStep } from './pipeline/processComment.js';
import { createCommentQueue, pruneWebhookEvents } from './queue/commentQueue.js';
import { createCoreServices } from './services.js';
import { createReplyWorker } from './worker/replyWorker.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const services = createCoreServices(config, logger);
  const { db } = services;
  const queue = createCommentQueue(db);

  // Extracción → filtros → respuesta (la respuesta llega en la fase e).
  const processComment = createCommentProcessor({ ...services.analysis, replyStep: pendingReplyStep });

  const worker = createReplyWorker({ db, queue, processComment, logger });

  const app = await buildApp({
    logger,
    webhook: {
      appSecret: config.webhook.appSecret,
      verifyToken: config.webhook.verifyToken,
      enqueue: (events, ctx) => queue.enqueueWebhookEvents(events, ctx.receivedAt, ctx.rawBody),
    },
    reports: { db, reportToken: config.reportToken },
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
