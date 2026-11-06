import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import type { FetchLike } from '../src/meta/http.js';
import { createTokenStore } from '../src/meta/token.js';

const DAY = 86_400_000;

function setup(fetchImpl?: FetchLike) {
  const db = openDb(':memory:');
  const calls: string[] = [];
  let now = Date.parse('2026-11-06T12:00:00Z');
  let n = 0;
  const f: FetchLike =
    fetchImpl ??
    (async (u) => {
      calls.push(u);
      return new Response(JSON.stringify({ access_token: `nuevo-${++n}`, token_type: 'bearer', expires_in: 5183944 }));
    });
  const make = (envToken = 'env-token') =>
    createTokenStore({ db, envToken, graph: { baseUrl: 'https://graph.instagram.com', version: 'v27.0', fetch: f, sleep: async () => {} }, now: () => now });
  return { db, calls, make, advance: (ms: number) => (now += ms), now: () => now };
}

describe('token de larga duración', () => {
  it('al principio usa IG_ACCESS_TOKEN sin escribir nada en la BD', () => {
    const { db, make } = setup();
    expect(make().get()).toBe('env-token');
    expect(db.prepare('SELECT COUNT(*) AS n FROM kv').get()).toEqual({ n: 0 });
  });

  it('refresca con GET /refresh_access_token?grant_type=ig_refresh_token (sin versión) y guarda el nuevo', async () => {
    const { calls, make, now } = setup();
    const t = make();
    expect(await t.refreshIfDue()).toBe(true);
    const u = new URL(calls[0]!);
    expect(u.origin + u.pathname).toBe('https://graph.instagram.com/refresh_access_token');
    expect(u.searchParams.get('grant_type')).toBe('ig_refresh_token');
    expect(u.searchParams.get('access_token')).toBe('env-token');
    expect(t.get()).toBe('nuevo-1');
    expect(t.status()).toMatchObject({ source: 'refreshed', refreshedAt: now(), expiresAt: now() + 5183944 * 1000 });
  });

  it('no vuelve a refrescar hasta pasados 7 días', async () => {
    const { calls, make, advance } = setup();
    const t = make();
    await t.refreshIfDue();
    advance(6 * DAY);
    expect(await t.refreshIfDue()).toBe(false);
    advance(1 * DAY);
    expect(await t.refreshIfDue()).toBe(true);
    expect(t.get()).toBe('nuevo-2');
    expect(new URL(calls[1]!).searchParams.get('access_token')).toBe('nuevo-1');
    expect(calls).toHaveLength(2);
  });

  it('otro proceso (p. ej. un comando CLI) ve el token refrescado', async () => {
    const { make } = setup();
    const server = make();
    const cli = make();
    await server.refreshIfDue();
    expect(cli.get()).toBe('nuevo-1');
  });

  it('si cambias IG_ACCESS_TOKEN en Railway, se adopta el nuevo', async () => {
    const { make } = setup();
    await make('env-token').refreshIfDue();
    expect(make('otro-token-del-panel').get()).toBe('otro-token-del-panel');
  });

  it('si el refresco falla, conserva el token anterior y guarda el error', async () => {
    const { make } = setup(async () => new Response('{"error":{"message":"token demasiado reciente","code":190}}', { status: 400 }));
    const t = make();
    await expect(t.refreshIfDue()).rejects.toThrow();
    expect(t.get()).toBe('env-token');
    expect(t.status().lastError).toContain('token demasiado reciente');
  });
});

describe('token con login unificado', () => {
  it('no se refresca (token de usuario del sistema sin caducidad)', async () => {
    const db = openDb(':memory:');
    let called = false;
    const t = createTokenStore({
      db,
      envToken: 'suat',
      refreshable: false,
      graph: { baseUrl: 'https://graph.facebook.com', version: 'v27.0', fetch: async () => ((called = true), new Response('{}')) },
    });
    expect(await t.refreshIfDue()).toBe(false);
    await expect(t.refreshIfDue(true)).rejects.toThrow(/no se refresca/);
    expect(called).toBe(false);
    expect(t.get()).toBe('suat');
  });
});
