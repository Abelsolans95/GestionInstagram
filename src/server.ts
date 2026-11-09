import './env.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createServiceProcessor } from './pipeline/accountProcessor.js';
import { getOwnIdentity } from './pipeline/context.js';
import { errorMessage } from './pipeline/log.js';
import { createCommentQueue, pruneWebhookEvents } from './queue/commentQueue.js';
import { createCoreServices } from './services.js';
import type { CommentEvent } from './webhook/parse.js';
import { createPoller } from './worker/poller.js';
import { createPublisher } from './worker/publisher.js';
import { createReplyWorker } from './worker/replyWorker.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const services = createCoreServices(config, logger);
  const { db, accounts } = services;
  const multi = accounts.all.length > 1;
  const queue = createCommentQueue(db);

  // Identidad (@usuario) de cada cuenta: la usan los prompts por cuenta y los informes.
  for (const a of accounts.all) {
    const me = await getOwnIdentity(a.analysis);
    logger.info({ account_id: a.id, username: me.username, primary: a.primary }, 'cuenta de Instagram');
  }

  // Worker de respuestas: cuenta → extracción → filtros → respuesta con Claude (→ revisión o programada)
  const processComment = createServiceProcessor({
    db,
    accounts,
    llm: services.llm,
    lists: services.lists,
    logger,
    settings: config.replies,
  });
  const worker = createReplyWorker({ db, queue, processComment, logger });

  // Publicador (parte del worker de respuestas): único que usa el cliente de escritura de Meta.
  const publisher = createPublisher({
    db,
    logger,
    maxPerHour: config.replies.maxPerHour,
    accounts: accounts.all.map((a) => ({ id: a.id, graph: a.graph, read: a.read, ownUsername: () => accounts.username(a.id) })),
    likeComments: config.replies.likeComments,
  });

  // Plan B opcional: leer comentarios recientes si los webhooks no llegan (un poller por cuenta).
  const pollers = accounts.all.map((a) =>
    createPoller({
      db,
      read: a.read,
      queue,
      logger: a.analysis.logger,
      intervalSec: config.poll.intervalSec,
      mediaCount: config.poll.mediaCount,
      accountId: a.id,
      sinceKey: a.primary ? 'poll_since' : `poll_since:${a.id}`,
    }),
  );

  // entry.id del webhook = cuenta que recibe el comentario. Si no es una de IG_USER_ID, el worker
  // la averigua por el vídeo (y se avisa una vez por si falta añadirla).
  const warnedAccounts = new Set<string>();
  const withKnownAccount = (e: CommentEvent): CommentEvent => {
    if (!e.accountId || accounts.get(e.accountId)) return e;
    if (!warnedAccounts.has(e.accountId)) {
      warnedAccounts.add(e.accountId);
      logger.warn({ entry_id: e.accountId }, 'webhook de una cuenta que no está en IG_USER_ID: se averigua por el vídeo');
    }
    return { ...e, accountId: null };
  };

  const app = await buildApp({
    logger,
    webhook: {
      appSecret: config.webhook.appSecret,
      verifyToken: config.webhook.verifyToken,
      enqueue: (events, ctx) => queue.enqueueWebhookEvents(events.map(withKnownAccount), ctx.receivedAt, ctx.rawBody),
    },
    reports: {
      db,
      reportToken: config.reportToken,
      votes: (mediaId) => {
        const a = accounts.forMedia(mediaId);
        return { read: a.read, ownUsername: async () => (await getOwnIdentity(a.analysis)).username };
      },
      accounts: () => (multi ? accounts.all.map((a) => ({ id: a.id, label: accounts.label(a.id) })) : []),
      // Radar de tendencias: lee otras cuentas con el token de la cuenta principal.
      radar: { read: accounts.primary.read },
    },
    review: {
      db,
      reportToken: config.reportToken,
      settings: config.replies,
      ...(multi ? { accountLabel: (id: string | null) => accounts.label(id ?? accounts.primary.id) } : {}),
    },
    status: {
      reportToken: config.reportToken,
      get: () => ({
        review_mode: config.replies.reviewMode,
        review_mode_cuentas: config.replies.reviewAccounts ?? [],
        replies_last_hour: publisher.repliesLastHour(),
        max_replies_per_hour: config.replies.maxPerHour,
        meta_login: config.meta.login,
        token: services.tokens.status(),
        polling: config.poll.intervalSec > 0,
        like_replied_comments: config.replies.likeComments,
        accounts: accounts.all.map((a) => ({
          id: a.id,
          username: accounts.username(a.id),
          primary: a.primary,
          replies_last_hour: publisher.repliesLastHour(a.id),
          token: a.tokens.status(),
        })),
      }),
    },
  });

  // Refresco del token de larga duración (60 días) — solo con META_LOGIN=instagram. Con el login
  // unificado el token de usuario del sistema no caduca por defecto.
  const refreshToken = async () => {
    for (const a of accounts.all) {
      try {
        if (await a.tokens.refreshIfDue()) logger.info({ account_id: a.id, ...a.tokens.status() }, 'token de Instagram refrescado');
      } catch (err) {
        const st = a.tokens.status();
        const daysLeft = st.expiresAt ? (st.expiresAt - Date.now()) / DAY_MS : null;
        const level = daysLeft !== null && daysLeft < 7 ? 'error' : 'warn';
        logger[level](
          { account_id: a.id, err: errorMessage(err), expires_in_days: daysLeft },
          'no se pudo refrescar el token (Meta exige que tenga al menos 24 h; se reintenta en 6 h)',
        );
      }
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
    for (const p of pollers) p.stop();
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
  for (const p of pollers) p.start();
  await app.listen({ port: config.port, host: config.host });
  logger.info(
    {
      review_mode: config.replies.reviewMode,
      model: config.claude.model,
      api_version: config.meta.apiVersion,
      meta_login: config.meta.login,
      graph_url: config.meta.graphUrl,
      accounts: accounts.all.map((a) => accounts.label(a.id)),
    },
    'servicio listo',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
