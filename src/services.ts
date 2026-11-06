/**
 * Servicios comunes (servidor y comandos CLI): BD, token, cliente de LECTURA de Meta, Claude,
 * prompts y listas de filtros. El cliente de ESCRITURA no se crea aquí a propósito: solo lo
 * crea el publicador del worker de respuestas (src/worker/publisher.ts).
 */
import type { AppConfig } from './config.js';
import { openDb, type DB } from './db/index.js';
import { createClaudeClient, type LlmClient } from './llm/claude.js';
import { createPromptStore, type PromptStore } from './llm/prompts.js';
import type { Logger } from './logger.js';
import type { FetchLike, GraphContext } from './meta/http.js';
import { createReadClient, type ReadClient } from './meta/readClient.js';
import { createTokenStore, type TokenStore } from './meta/token.js';
import type { AnalysisDeps } from './pipeline/context.js';
import { createFilterLists, type FilterLists } from './pipeline/filters.js';

export interface CoreServices {
  config: AppConfig;
  logger: Logger;
  db: DB;
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
  prompts?: PromptStore;
  lists?: FilterLists;
  sleep?: (ms: number) => Promise<void>;
}

export function createCoreServices(
  config: AppConfig,
  logger: Logger,
  overrides: ServiceOverrides = {},
): CoreServices {
  const db = overrides.db ?? openDb(config.databasePath);
  const graphBase = {
    baseUrl: config.meta.graphUrl,
    version: config.meta.apiVersion,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
  };
  const tokens = createTokenStore({ db, envToken: config.meta.accessToken, graph: graphBase });
  const graph: GraphContext = { ...graphBase, getAccessToken: () => tokens.get() };
  const read = createReadClient({
    graph,
    igUserId: config.meta.igUserId,
    onWarning: (msg, data) => logger.warn(data ?? {}, msg),
  });
  const llm =
    overrides.llm ?? createClaudeClient({ apiKey: config.claude.apiKey, model: config.claude.model });
  const prompts = overrides.prompts ?? createPromptStore();
  const lists = overrides.lists ?? createFilterLists();
  const analysis: AnalysisDeps = { db, read, llm, prompts, lists, igUserId: config.meta.igUserId, logger };
  return { config, logger, db, tokens, graph, read, llm, prompts, lists, analysis };
}
