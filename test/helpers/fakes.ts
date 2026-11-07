import type { AppConfig } from '../../src/config.js';
import type { JsonCompletionRequest, LlmClient } from '../../src/llm/claude.js';
import { staticPromptStore } from '../../src/llm/prompts.js';
import { createLogger } from '../../src/logger.js';
import { staticFilterLists } from '../../src/pipeline/filters.js';

export const silentLogger = createLogger('silent');

export const IG_USER_ID = '17841400000000001';
export const OWN_USERNAME = 'humanidaddesdecero';

export function testConfig(overrides: Partial<AppConfig['replies']> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    databasePath: ':memory:',
    webhook: { appSecret: 'app-secret', verifyToken: 'verify' },
    meta: {
      appId: null,
      accessToken: 'env-token',
      igUserId: IG_USER_ID,
      apiVersion: 'v27.0',
      graphUrl: 'https://graph.facebook.com',
      login: 'unified',
    },
    claude: { apiKey: 'test', model: 'claude-haiku-5-5', workspaceId: null },
    replies: {
      delayMinSec: 60,
      delayMaxSec: 300,
      maxPerHour: 60,
      reviewMode: true,
      maxAgeHours: 0,
      likeComments: false,
      ...overrides,
    },
    reportToken: 'report-token-0123456789',
    poll: { intervalSec: 0, mediaCount: 5 },
    ignoredReels: [],
  };
}

/** LLM falso: decide la respuesta según la tarea y el texto del mensaje de usuario. */
export function fakeLlm(handler: (req: JsonCompletionRequest) => unknown) {
  const calls: JsonCompletionRequest[] = [];
  const llm: LlmClient = {
    async completeJson(req) {
      calls.push(req);
      const out = handler(req);
      if (out instanceof Error) throw out;
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
  };
  return { llm, calls };
}

export const testPrompts = staticPromptStore({ reply: 'REPLY', extract: 'EXTRACT', question: 'QUESTION' });
export const testLists = staticFilterLists(['gilipoll*', 'hijo de puta'], ['gana dinero', 'mira mi perfil']);

/** Comentario citado en el mensaje de usuario de la extracción (la última línea entre """). */
export function commentTextOf(req: JsonCompletionRequest): string {
  const m = /Comentario de @[^:]*:\n"""([\s\S]*)"""$/.exec(req.user);
  return m?.[1] ?? '';
}
