/**
 * Token de usuario de Instagram de larga duración (60 días) y su refresco automático.
 *
 * Documentación (Refresh Access Token): GET https://graph.instagram.com/refresh_access_token
 *   ?grant_type=ig_refresh_token&access_token=<token>
 * Solo funciona con un token de larga duración que tenga al menos 24 h y no haya caducado; el
 * nuevo dura 60 días desde el refresco. Railway no deja que la app reescriba sus variables, así
 * que el token vigente se guarda en SQLite (tabla kv). IG_ACCESS_TOKEN es solo el inicial: si lo
 * cambias en Railway, se adopta el nuevo.
 */
import { createHash } from 'node:crypto';
import { kvGet, kvSet, type DB } from '../db/index.js';
import { graphGet, MetaApiError, type GraphContext } from './http.js';

const KEY = 'ig_access_token';
const DAY_MS = 24 * 60 * 60 * 1000;

interface StoredToken {
  token: string;
  /** Huella del IG_ACCESS_TOKEN del entorno del que procede (para detectar que lo has cambiado). */
  envFingerprint: string;
  obtainedAt: number;
  refreshedAt: number | null;
  expiresAt: number | null;
  lastError?: string | null;
}

export interface TokenStatus {
  source: 'env' | 'refreshed';
  refreshedAt: number | null;
  expiresAt: number | null;
  lastError: string | null;
}

export interface TokenStore {
  get(): string;
  status(): TokenStatus;
  /** Refresca si toca (por defecto cada 7 días). Devuelve true si se ha refrescado. */
  refreshIfDue(force?: boolean): Promise<boolean>;
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export interface TokenStoreOptions {
  db: DB;
  envToken: string;
  /** Contexto Graph para el refresco (usa graphGet sin versión). */
  graph: Omit<GraphContext, 'getAccessToken'>;
  refreshEveryMs?: number;
  now?: () => number;
}

export function createTokenStore(opts: TokenStoreOptions): TokenStore {
  const { db, envToken } = opts;
  const now = opts.now ?? Date.now;
  const refreshEveryMs = opts.refreshEveryMs ?? 7 * DAY_MS;
  const envFp = fingerprint(envToken);

  // Token del entorno en memoria (sin persistir) mientras no haya un refresco guardado.
  const fromEnv: StoredToken = {
    token: envToken,
    envFingerprint: envFp,
    obtainedAt: now(),
    refreshedAt: null,
    expiresAt: null,
    lastError: null,
  };

  /**
   * Token vigente: el guardado en SQLite si procede del IG_ACCESS_TOKEN actual; si no (primera vez,
   * o has cambiado IG_ACCESS_TOKEN en Railway), el del entorno. No escribe nada: solo se guarda al
   * refrescar, así un --dry-run no toca la base de datos.
   */
  function load(): StoredToken {
    const stored = kvGet<StoredToken>(db, KEY);
    return stored && stored.envFingerprint === envFp ? stored : fromEnv;
  }

  return {
    get() {
      // Otro proceso (servidor/CLI) puede haberlo refrescado: leemos siempre lo último guardado.
      return load().token;
    },
    status() {
      const current = load();
      return {
        source: current.refreshedAt ? 'refreshed' : 'env',
        refreshedAt: current.refreshedAt,
        expiresAt: current.expiresAt,
        lastError: current.lastError ?? null,
      };
    },
    async refreshIfDue(force = false) {
      let current = load();
      const last = current.refreshedAt ?? current.obtainedAt;
      const neverRefreshed = current.refreshedAt === null;
      const due = force || neverRefreshed || now() - last >= refreshEveryMs;
      if (!due) return false;
      const token = current.token;
      try {
        const res = await graphGet<{ access_token: string; token_type?: string; expires_in?: number }>(
          { ...opts.graph, getAccessToken: () => token },
          'refresh_access_token',
          { grant_type: 'ig_refresh_token' },
          { versioned: false },
        );
        if (!res.access_token) throw new Error('respuesta sin access_token');
        current = {
          ...current,
          token: res.access_token,
          refreshedAt: now(),
          expiresAt: typeof res.expires_in === 'number' ? now() + res.expires_in * 1000 : null,
          lastError: null,
        };
        kvSet(db, KEY, current, now());
        return true;
      } catch (err) {
        const msg = err instanceof MetaApiError || err instanceof Error ? err.message : String(err);
        current = { ...current, lastError: msg };
        kvSet(db, KEY, current, now());
        throw err;
      }
    },
  };
}
