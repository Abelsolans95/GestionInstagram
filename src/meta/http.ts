/**
 * Transporte HTTP hacia la Graph API de Instagram (graph.instagram.com) con reintentos y backoff.
 *
 * Expone dos funciones separadas a propósito:
 *  - graphGet  → la usa el cliente de LECTURA (readClient.ts) y el refresco del token.
 *  - graphPost → la usa SOLO el cliente de ESCRITURA (writeClient.ts). Un test de arquitectura
 *                comprueba que ningún otro fichero la importe.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GraphContext {
  /** https://graph.instagram.com */
  baseUrl: string;
  /** p. ej. v27.0 */
  version: string;
  getAccessToken: () => string;
  fetch?: FetchLike;
  /** Intentos totales por llamada (por defecto 3). */
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_GRAPH_BASE_URL = 'https://graph.instagram.com';

/** Error devuelto por la Graph API ({"error": {...}}) o por la red. */
export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: number | null = null,
    readonly subcode: number | null = null,
    readonly isTransient = false,
    readonly fbtraceId: string | null = null,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

/** Códigos de la Graph API de error temporal o de límite de llamadas. */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

export function isRetryableGetError(err: unknown): boolean {
  if (err instanceof MetaApiError) {
    if (err.status === null) return true; // red / timeout
    if (err.status >= 500 || err.status === 429) return true;
    return err.isTransient || (err.code !== null && RETRYABLE_CODES.has(err.code));
  }
  return true;
}

type Params = Record<string, string | number | boolean | undefined>;

function buildUrl(ctx: GraphContext, path: string, params: Params, versioned: boolean): string {
  const clean = path.replace(/^\/+/, '');
  const url = new URL(versioned ? `${ctx.baseUrl}/${ctx.version}/${clean}` : `${ctx.baseUrl}/${clean}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('access_token', ctx.getAccessToken());
  return url.toString();
}

// Tokens de Meta (Facebook/usuario del sistema: EAA…, Instagram: IGAA… / IGQ…).
const TOKEN_LIKE = /\b(?:EAA|IGAA|IGQ)[A-Za-z0-9_-]{20,}/g;

/**
 * Quita tokens de un texto. Meta repite el token en algunos mensajes de error
 * (p. ej. "Malformed access token EAA…") y esos mensajes acaban en los logs.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  }
  return out.replace(TOKEN_LIKE, '[REDACTED]');
}

async function parseError(res: Response, secrets: string[]): Promise<MetaApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const e = (body as { error?: Record<string, unknown> } | undefined)?.error;
  if (e && typeof e === 'object') {
    return new MetaApiError(
      `Meta API ${res.status}: ${redactSecrets(String(e.message ?? 'error'), secrets)}`,
      res.status,
      typeof e.code === 'number' ? e.code : null,
      typeof e.error_subcode === 'number' ? e.error_subcode : null,
      e.is_transient === true,
      typeof e.fbtrace_id === 'string' ? e.fbtrace_id : null,
    );
  }
  return new MetaApiError(`Meta API ${res.status}`, res.status);
}

async function send(ctx: GraphContext, method: 'GET' | 'POST', url: string, body?: unknown): Promise<unknown> {
  const doFetch = ctx.fetch ?? ((u, i) => fetch(u, i));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch (err) {
    // Sin respuesta (red caída, DNS, timeout). Nunca incluimos la URL: lleva el token.
    const reason = err instanceof Error ? err.name : 'error';
    throw new MetaApiError(`Meta API sin respuesta (${reason})`, null);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let token: string | undefined;
    try {
      token = new URL(url).searchParams.get('access_token') ?? undefined;
    } catch {
      token = undefined;
    }
    throw await parseError(res, token ? [token, ...token.split(/\s+/)] : []);
  }
  return res.json();
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ejecuta `fn` hasta maxAttempts veces con backoff exponencial y jitter. */
export async function withRetries<T>(
  ctx: Pick<GraphContext, 'maxAttempts' | 'baseDelayMs' | 'sleep'>,
  fn: () => Promise<T>,
  isRetryable: (err: unknown) => boolean,
): Promise<T> {
  const attempts = Math.max(1, ctx.maxAttempts ?? 3);
  const base = ctx.baseDelayMs ?? 1000;
  const sleep = ctx.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !isRetryable(err)) break;
      await sleep(base * 2 ** (i - 1) * (0.75 + Math.random() * 0.5));
    }
  }
  throw lastErr;
}

/** GET con reintentos. */
export function graphGet<T>(
  ctx: GraphContext,
  path: string,
  params: Params = {},
  opts: { versioned?: boolean } = {},
): Promise<T> {
  return withRetries(
    ctx,
    async () => (await send(ctx, 'GET', buildUrl(ctx, path, params, opts.versioned ?? true))) as T,
    isRetryableGetError,
  );
}

/**
 * POST. Reintenta solo cuando es seguro que Meta NO ha creado nada (429 / límite de llamadas).
 * Ante un fallo ambiguo (sin respuesta, 5xx) lanza el error y decide quien llama
 * (el publicador comprueba antes si la respuesta ya existe para no duplicarla).
 */
export function graphPost<T>(
  ctx: GraphContext,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  return withRetries(
    ctx,
    async () => (await send(ctx, 'POST', buildUrl(ctx, path, {}, true), body)) as T,
    (err) =>
      err instanceof MetaApiError &&
      err.status !== null &&
      (err.status === 429 || (err.status < 500 && err.code !== null && [4, 17, 32, 613].includes(err.code))),
  );
}
