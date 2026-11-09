import { resolveAccount, type Account, type Accounts } from '../accounts.js';
import { updateComment } from '../db/comments.js';
import type { DB } from '../db/index.js';
import type { LlmClient } from '../llm/claude.js';
import type { Logger } from '../logger.js';
import type { CommentProcessor } from '../worker/replyWorker.js';
import type { FilterLists } from './filters.js';
import { createCommentProcessor } from './processComment.js';
import { createReplyStep, type ReplySettings } from './replyStep.js';

/**
 * Procesador con varias cuentas: averigua de qué cuenta es el comentario, lo guarda y lo pasa al
 * procesador de esa cuenta (con su token, sus prompts y su identidad).
 */
export function createAccountProcessor(opts: {
  db: DB;
  accounts: Accounts;
  logger: Logger;
  processorFor: (account: Account) => CommentProcessor;
}): CommentProcessor {
  const cache = new Map<string, CommentProcessor>();
  return async (row) => {
    const account = await resolveAccount(opts.db, opts.accounts, row, opts.logger);
    if (row.account_id !== account.id) updateComment(opts.db, row.comment_id, { account_id: account.id });
    let processor = cache.get(account.id);
    if (!processor) {
      processor = opts.processorFor(account);
      cache.set(account.id, processor);
    }
    return processor({ ...row, account_id: account.id });
  };
}

/** El procesador del servicio: por cada cuenta, extracción → filtros → respuesta con sus prompts. */
export function createServiceProcessor(opts: {
  db: DB;
  accounts: Accounts;
  llm: LlmClient;
  lists: FilterLists;
  logger: Logger;
  settings: ReplySettings;
  now?: () => number;
  random?: () => number;
}): CommentProcessor {
  const { db, accounts } = opts;
  return createAccountProcessor({
    db,
    accounts,
    logger: opts.logger,
    processorFor: (a) =>
      createCommentProcessor({
        ...a.analysis,
        ...(opts.now ? { now: opts.now } : {}),
        replyStep: createReplyStep({
          db,
          llm: opts.llm,
          prompts: a.prompts,
          lists: opts.lists,
          logger: a.analysis.logger,
          // REVIEW_MODE global o, para esta cuenta, REVIEW_MODE_CUENTAS (se mira en cada comentario).
          settings: {
            ...opts.settings,
            get reviewMode() {
              const list = opts.settings.reviewAccounts ?? [];
              const username = accounts.username(a.id);
              return opts.settings.reviewMode || list.includes(a.id) || (!!username && list.includes(username));
            },
          },
          accountId: a.id,
          ...(opts.now ? { now: opts.now } : {}),
          ...(opts.random ? { random: opts.random } : {}),
        }),
        otherOwnAccounts: () => accounts.identities().filter((o) => o.userId !== a.id),
      }),
  });
}
