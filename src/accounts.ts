/**
 * Varias cuentas de Instagram en el mismo servicio (IG_USER_ID con varios IDs separados por comas).
 * Cada cuenta tiene su token, su cliente de LECTURA y sus prompts; la BD, Claude y los filtros son
 * comunes. El cliente de escritura sigue creándose solo en el publicador (uno por cuenta).
 */
import type { AccountConfig } from './config.js';
import { getMedia } from './db/analysis.js';
import type { CommentRow } from './db/comments.js';
import type { DB } from './db/index.js';
import type { LlmClient } from './llm/claude.js';
import { createAccountPromptStore, type PromptStore } from './llm/prompts.js';
import type { Logger } from './logger.js';
import type { GraphContext } from './meta/http.js';
import { createReadClient, type ReadClient } from './meta/readClient.js';
import { createTokenStore, type TokenStore } from './meta/token.js';
import { cachedOwnUsername, type AnalysisDeps } from './pipeline/context.js';
import type { FilterLists, OwnIdentity } from './pipeline/filters.js';
import { errorMessage } from './pipeline/log.js';

export interface Account {
  id: string;
  /** La primera de IG_USER_ID: la de los prompts generales y la de los datos de antes. */
  primary: boolean;
  tokens: TokenStore;
  graph: GraphContext;
  read: ReadClient;
  prompts: PromptStore;
  /** Dependencias del análisis de esta cuenta (solo lectura de Meta). */
  analysis: AnalysisDeps;
}

export interface Accounts {
  all: Account[];
  primary: Account;
  get(id: string | null | undefined): Account | undefined;
  /** @usuario guardado de la cuenta (null si todavía no se ha leído de Meta). */
  username(id: string): string | null;
  /** "@usuario", o el ID si aún no se conoce. */
  label(id: string | null | undefined): string;
  /** Por @usuario o ID (para --cuenta). Lanza si no es una de tus cuentas. */
  find(ref: string): Account;
  /** Cuenta dueña de un vídeo ya guardado (si no se sabe, la principal). */
  forMedia(mediaId: string): Account;
  /** Todas tus cuentas (para no responder a tus propios comentarios desde otra cuenta). */
  identities(): OwnIdentity[];
}

export interface AccountsOptions {
  db: DB;
  accounts: AccountConfig[];
  graph: Omit<GraphContext, 'getAccessToken'>;
  login: 'unified' | 'instagram';
  llm: LlmClient;
  lists: FilterLists;
  logger: Logger;
  /** Para tests: prompts fijos (para todas las cuentas o por ID de cuenta). */
  prompts?: PromptStore | ((accountId: string) => PromptStore);
  promptsDir?: string;
}

export function createAccounts(opts: AccountsOptions): Accounts {
  const { db, logger } = opts;
  if (!opts.accounts.length) throw new Error('No hay ninguna cuenta en IG_USER_ID');
  const all: Account[] = opts.accounts.map((cfg, i) => {
    const primary = i === 0;
    const tokens = createTokenStore({
      db,
      envToken: cfg.accessToken,
      graph: opts.graph,
      refreshable: opts.login === 'instagram',
      key: primary ? 'ig_access_token' : `ig_access_token:${cfg.id}`,
    });
    const graph: GraphContext = { ...opts.graph, getAccessToken: () => tokens.get() };
    const read = createReadClient({
      graph,
      igUserId: cfg.id,
      login: opts.login,
      onWarning: (msg, data) => logger.warn({ account_id: cfg.id, ...(data ?? {}) }, msg),
    });
    const prompts =
      typeof opts.prompts === 'function'
        ? opts.prompts(cfg.id)
        : (opts.prompts ??
          createAccountPromptStore({
            primary,
            ...(opts.promptsDir ? { dir: opts.promptsDir } : {}),
            folders: () => [cachedOwnUsername(db, cfg.id), cfg.id].filter((x): x is string => !!x),
          }));
    const analysis: AnalysisDeps = {
      db,
      read,
      llm: opts.llm,
      prompts,
      lists: opts.lists,
      igUserId: cfg.id,
      logger: opts.accounts.length > 1 ? logger.child({ account_id: cfg.id }) : logger,
    };
    return { id: cfg.id, primary, tokens, graph, read, prompts, analysis };
  });
  const byId = new Map(all.map((a) => [a.id, a]));
  const primary = all[0]!;

  const username = (id: string) => cachedOwnUsername(db, id);
  return {
    all,
    primary,
    get: (id) => (id ? byId.get(id) : undefined),
    username,
    label: (id) => {
      if (!id) return '?';
      const u = username(id);
      return u ? `@${u}` : id;
    },
    find(ref) {
      const r = ref.trim().replace(/^@/, '').toLowerCase();
      const hit = byId.get(r) ?? all.find((a) => username(a.id) === r);
      if (hit) return hit;
      const known = all.map((a) => (username(a.id) ? `@${username(a.id)} (${a.id})` : a.id)).join(', ');
      throw new Error(`"${ref}" no es una de tus cuentas. Cuentas configuradas en IG_USER_ID: ${known}`);
    },
    forMedia(mediaId) {
      const m = getMedia(db, mediaId);
      return (m?.is_own === 1 ? byId.get(m.account_id ?? '') : undefined) ?? primary;
    },
    identities: () => all.map((a) => ({ userId: a.id, username: username(a.id) })),
  };
}

/**
 * ¿De qué cuenta es este comentario? Por orden: la que vino en el webhook (entry.id), la dueña ya
 * conocida del vídeo, la única configurada o, si hay varias, la que puede leer el vídeo y es su
 * dueña. Si ninguna lo es, la principal (y el procesador lo descartará como vídeo ajeno).
 */
export async function resolveAccount(db: DB, accounts: Accounts, row: Pick<CommentRow, 'account_id' | 'media_id' | 'comment_id'>, logger?: Logger): Promise<Account> {
  const byRow = accounts.get(row.account_id);
  if (byRow) return byRow;
  const media = getMedia(db, row.media_id);
  const byMedia = media?.is_own === 1 ? accounts.get(media.account_id) : undefined;
  if (byMedia) return byMedia;
  if (accounts.all.length === 1) return accounts.primary;
  for (const a of accounts.all) {
    try {
      const m = await a.read.getMedia(row.media_id);
      const own = accounts.username(a.id);
      if (m.owner?.id === a.id || (!!own && m.username?.toLowerCase() === own)) return a;
    } catch (err) {
      logger?.debug({ account_id: a.id, media_id: row.media_id, err: errorMessage(err) }, 'esta cuenta no puede leer el vídeo');
    }
  }
  logger?.warn({ comment_id: row.comment_id, media_id: row.media_id }, 'no se sabe de qué cuenta es el vídeo: se usa la principal');
  return accounts.primary;
}
