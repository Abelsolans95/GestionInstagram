import './env.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { kvGet } from './db/index.js';
import { createLogger } from './logger.js';
import { createCommentProcessor } from './pipeline/processComment.js';
import { errorMessage } from './pipeline/log.js';
import { createReplyStep } from './pipeline/replyStep.js';
import { createCommentQueue, pruneWebhookEvents } from './queue/commentQueue.js';
import { createCoreServices } from './services.js';
import { createPoller } from './worker/poller.js';
import { createPublisher } from './worker/publisher.js';
import { createReplyWorker } from './worker/replyWorker.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const services = createCoreServices(config, logger);
  const { db } = services;
  const queue = createCommentQueue(db);

  // Worker de respuestas: extracción → filtros → respuesta con Claude (→ revisión o programada)
  const replyStep = createReplyStep({
    db,
    llm: services.llm,
    prompts: services.prompts,
    lists: services.lists,
    logger,
    settings: config.replies,
  });
  const processComment = createCommentProcessor({ ...services.analysis, replyStep });
  const worker = createReplyWorker({ db, queue, processComment, logger });

  // Publicador (parte del worker de respuestas): único que usa el cliente de escritura de Meta.
  const publisher = createPublisher({
    db,
    graph: services.graph,
    read: services.read,
    logger,
    maxPerHour: config.replies.maxPerHour,
    igUserId: config.meta.igUserId,
    ownUsername: () => kvGet<{ username: string | null }>(db, 'own_identity')?.username ?? null,
    likeComments: config.replies.likeComments,
  });

  // Plan B opcional: leer comentarios recientes si los webhooks no llegan.
  const poller = createPoller({
    db,
    read: services.read,
    queue,
    logger,
    intervalSec: config.poll.intervalSec,
    mediaCount: config.poll.mediaCount,
  });

  const app = await buildApp({
    logger,
    webhook: {
      appSecret: config.webhook.appSecret,
      verifyToken: config.webhook.verifyToken,
      enqueue: (events, ctx) => queue.enqueueWebhookEvents(events, ctx.receivedAt, ctx.rawBody),
    },
    reports: { db, reportToken: config.reportToken },
    review: { db, reportToken: config.reportToken, settings: config.replies },
    status: {
      reportToken: config.reportToken,
      get: () => ({
        review_mode: config.replies.reviewMode,
        replies_last_hour: publisher.repliesLastHour(),
        max_replies_per_hour: config.replies.maxPerHour,
        meta_login: config.meta.login,
        token: services.tokens.status(),
        polling: config.poll.intervalSec > 0,
        like_replied_comments: config.replies.likeComments,
      }),
    },
  });

  // Refresco del token de larga duración (60 días) — solo con META_LOGIN=instagram. Con el login
  // unificado el token de usuario del sistema no caduca por defecto.
  const refreshToken = async () => {
    try {
      if (await services.tokens.refreshIfDue()) logger.info(services.tokens.status(), 'token de Instagram refrescado');
    } catch (err) {
      const st = services.tokens.status();
      const daysLeft = st.expiresAt ? (st.expiresAt - Date.now()) / DAY_MS : null;
      const level = daysLeft !== null && daysLeft < 7 ? 'error' : 'warn';
      logger[level](
        { err: errorMessage(err), expires_in_days: daysLeft },
        'no se pudo refrescar el token (Meta exige que tenga al menos 24 h; se reintenta en 6 h)',
      );
    }
  };
  if (config.meta.login === 'instagram') {
    const tokenTimer = setInterval(() => void refreshToken(), 6 * HOUR_MS);
    tokenTimer.unref();
    setTimeout(() => void refreshToken(), 60_000).unref();
  }

  const prune = () => {
    const n = pruneWebhookEvents(db, 30 * DAY_MS);
    if (n) logger.info({ removed: n }, 'eventos de webhook antiguos borrados');
  };
  prune();
  setInterval(prune, DAY_MS).unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'apagando');
    poller.stop();
    await app.close();
    await worker.stop();
    await publisher.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  worker.start();
  publisher.start();
  poller.start();
  await app.listen({ port: config.port, host: config.host });
  logger.info(
    {
      review_mode: config.replies.reviewMode,
      model: config.claude.model,
      api_version: config.meta.apiVersion,
      meta_login: config.meta.login,
      graph_url: config.meta.graphUrl,
    },
    'servicio listo',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
