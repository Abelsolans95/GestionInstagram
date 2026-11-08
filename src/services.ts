/**
 * Servicios comunes (servidor y comandos CLI): BD, cuentas (token, cliente de LECTURA de Meta y
 * prompts de cada una), Claude y listas de filtros. El cliente de ESCRITURA no se crea aquí a
 * propósito: solo lo crea el publicador del worker de respuestas (src/worker/publisher.ts).
 */
import { createAccounts, type Accounts } from './accounts.js';
import type { AppConfig } from './config.js';
import { assignLegacyRows } from './db/analysis.js';
import { openDb, type DB } from './db/index.js';
import { createClaudeClient, type LlmClient } from './llm/claude.js';
import type { PromptStore } from './llm/prompts.js';
import type { Logger } from './logger.js';
import type { FetchLike, GraphContext } from './meta/http.js';
import type { ReadClient } from './meta/readClient.js';
import type { TokenStore } from './meta/token.js';
import type { AnalysisDeps } from './pipeline/context.js';
import { createFilterLists, type FilterLists } from './pipeline/filters.js';

export interface CoreServices {
  config: AppConfig;
  logger: Logger;
  db: DB;
  /** Todas tus cuentas de Instagram. Los campos de abajo son los de la principal. */
  accounts: Accounts;
  tokens: TokenStore;
  graph: GraphContext;
  read: ReadClient;
  llm: LlmClient;
  prompts: PromptStore;
  lists: FilterLists;
  analysis: AnalysisDeps;
}

export interface ServiceOverrides {
  db?: DB;
  fetch?: FetchLike;
  llm?: LlmClient;
  /** Prompts fijos para todas las cuentas, o por ID de cuenta. */
  prompts?: PromptStore | ((accountId: string) => PromptStore);
  lists?: FilterLists;
  sleep?: (ms: number) => Promise<void>;
}

export function createCoreServices(
  config: AppConfig,
  logger: Logger,
  overrides: ServiceOverrides = {},
): CoreServices {
  const db = overrides.db ?? openDb(config.databasePath);
  const accountConfigs = config.meta.accounts?.length
    ? config.meta.accounts
    : [{ id: config.meta.igUserId, accessToken: config.meta.accessToken }];
  const assigned = assignLegacyRows(db, accountConfigs[0]!.id);
  if (assigned) logger.info({ comments: assigned, account_id: accountConfigs[0]!.id }, 'datos anteriores asignados a la cuenta principal');

  const llm =
    overrides.llm ??
    createClaudeClient({ apiKey: config.claude.apiKey, model: config.claude.model, workspaceId: config.claude.workspaceId });
  const lists = overrides.lists ?? createFilterLists();
  const accounts = createAccounts({
    db,
    accounts: accountConfigs,
    graph: {
      baseUrl: config.meta.graphUrl,
      version: config.meta.apiVersion,
      ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
      ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
    },
    login: config.meta.login,
    llm,
    lists,
    logger,
    ...(overrides.prompts ? { prompts: overrides.prompts } : {}),
  });
  const p = accounts.primary;
  return {
    config,
    logger,
    db,
    accounts,
    tokens: p.tokens,
    graph: p.graph,
    read: p.read,
    llm,
    prompts: p.prompts,
    lists,
    analysis: p.analysis,
  };
}
