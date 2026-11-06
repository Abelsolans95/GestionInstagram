import Anthropic from '@anthropic-ai/sdk';

/**
 * Petición a un LLM que debe devolver SOLO JSON conforme a `schema`.
 * Devolvemos el texto crudo: el parseo y la validación se hacen fuera (reply.ts / extract.ts),
 * para poder descartar y registrar en el log una salida que no parsee.
 */
export interface JsonCompletionRequest {
  /** Para el log: 'reply' | 'extract' | 'question'. */
  task: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface LlmClient {
  completeJson(req: JsonCompletionRequest): Promise<string>;
}

/** El modelo se negó a responder (stop_reason "refusal"). */
export class LlmRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`el modelo se negó a responder${category ? ` (${category})` : ''}`);
    this.name = 'LlmRefusalError';
  }
}

/** Salida del modelo inutilizable (JSON inválido, no cumple el esquema, cortada...). */
export class LlmOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string | null = null,
  ) {
    super(message);
    this.name = 'LlmOutputError';
  }
}

export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';

export interface ClaudeOptions {
  apiKey: string;
  model?: string;
  /** Esfuerzo de razonamiento: estas tareas son cortas, 'low' basta. */
  effort?: 'low' | 'medium' | 'high';
  /** Reintentos del SDK (429, 5xx, red) con backoff: 2 reintentos = 3 intentos en total. */
  maxRetries?: number;
  timeoutMs?: number;
  /** Por defecto el del SDK (o ANTHROPIC_BASE_URL si está definido). */
  baseURL?: string;
}

export function createClaudeClient(opts: ClaudeOptions): LlmClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: opts.maxRetries ?? 2,
    timeout: opts.timeoutMs ?? 60_000,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  const model = opts.model ?? DEFAULT_CLAUDE_MODEL;
  const effort = opts.effort ?? 'low';

  return {
    async completeJson(req) {
      const res = await client.messages.create({
        model,
        max_tokens: req.maxTokens ?? 4096,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: {
          effort,
          format: { type: 'json_schema', schema: req.schema },
        },
      });
      if (res.stop_reason === 'refusal') {
        throw new LlmRefusalError(res.stop_details?.category ?? null);
      }
      const text = res.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      if (res.stop_reason === 'max_tokens') {
        throw new LlmOutputError('respuesta cortada por max_tokens', text);
      }
      return text;
    },
  };
}
