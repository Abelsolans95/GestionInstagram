import { describe, expect, it } from 'vitest';
import { graphGet, MetaApiError, type FetchLike } from '../src/meta/http.js';
import { createReadClient } from '../src/meta/readClient.js';
import { createFakeMeta } from './helpers/fakeMeta.js';
import { IG_USER_ID, OWN_USERNAME } from './helpers/fakes.js';

const noSleep = async () => {};

function graphFor(fetchImpl: FetchLike) {
  return {
    baseUrl: 'https://graph.instagram.com',
    version: 'v27.0',
    getAccessToken: () => 'SECRET-TOKEN',
    fetch: fetchImpl,
    sleep: noSleep,
  };
}

const media = [{ id: 'm1', caption: '¿qué oficio quieres?', permalink: 'p', shortcode: 'AAA', timestamp: '2026-10-01T10:00:00+0000', media_type: 'VIDEO', owner: { id: IG_USER_ID } }];

describe('transporte Graph API', () => {
  it('usa la versión configurada, graph.instagram.com y el token como access_token', async () => {
    const urls: string[] = [];
    const f: FetchLike = async (u) => {
      urls.push(u);
      return new Response('{"user_id":"1","username":"x"}');
    };
    await graphGet(graphFor(f), 'me', { fields: 'user_id,username' });
    const u = new URL(urls[0]!);
    expect(u.origin + u.pathname).toBe('https://graph.instagram.com/v27.0/me');
    expect(u.searchParams.get('access_token')).toBe('SECRET-TOKEN');
  });

  it('reintenta errores temporales con backoff (3 intentos) y luego falla', async () => {
    let n = 0;
    const f: FetchLike = async () => {
      n++;
      return new Response('{"error":{"message":"temporal","code":2,"is_transient":true}}', { status: 500 });
    };
    await expect(graphGet(graphFor(f), 'me')).rejects.toBeInstanceOf(MetaApiError);
    expect(n).toBe(3);
  });

  it('se recupera si un reintento funciona', async () => {
    let n = 0;
    const f: FetchLike = async () => (++n < 3 ? new Response('{}', { status: 503 }) : new Response('{"ok":true}'));
    expect(await graphGet(graphFor(f), 'x')).toEqual({ ok: true });
  });

  it('no reintenta errores definitivos (400)', async () => {
    let n = 0;
    const f: FetchLike = async () => {
      n++;
      return new Response('{"error":{"message":"Invalid OAuth access token","code":190}}', { status: 400 });
    };
    const err = await graphGet(graphFor(f), 'me').catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: 190 });
    expect(n).toBe(1);
  });

  it('los errores de red no incluyen la URL (lleva el token)', async () => {
    const f: FetchLike = async () => {
      throw new TypeError('fetch failed https://graph.instagram.com/v27.0/me?access_token=SECRET-TOKEN');
    };
    const err = (await graphGet(graphFor(f), 'me').catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('SECRET-TOKEN');
  });
});

describe('cliente de lectura', () => {
  it('si Meta rechaza un campo opcional (p. ej. caption), sigue sin él', async () => {
    const meta = createFakeMeta({ igUserId: IG_USER_ID, username: OWN_USERNAME, media, threads: {}, rejectFields: ['caption'] });
    const warnings: string[] = [];
    const read = createReadClient({ graph: graphFor(meta.fetch), igUserId: IG_USER_ID, onWarning: (m) => warnings.push(m) });
    const m = await read.getMedia('m1');
    expect(m).toMatchObject({ id: 'm1', shortcode: 'AAA' });
    expect(m.caption).toBeUndefined();
    expect(warnings).toHaveLength(1);
    await read.getMedia('m1'); // ya no vuelve a pedir caption
    expect(meta.calls.filter((c) => c.params.fields?.includes('caption'))).toHaveLength(1);
  });

  it('pagina /comments y completa las respuestas por /replies', async () => {
    const threads = {
      m1: [1, 2, 3].map((i) => ({
        comment: { id: `c${i}`, text: `t${i}`, username: `u${i}` },
        replies: i === 1 ? [1, 2, 3].map((j) => ({ id: `r${j}`, text: `r${j}`, username: `v${j}` })) : [],
      })),
    };
    const meta = createFakeMeta({ igUserId: IG_USER_ID, username: OWN_USERNAME, media, threads, pageSize: 2, expandedReplies: 1 });
    const read = createReadClient({ graph: graphFor(meta.fetch), igUserId: IG_USER_ID });
    const out = [];
    for await (const t of read.listThreads('m1')) out.push(t);
    expect(out.map((t) => t.comment.id)).toEqual(['c1', 'c2', 'c3']);
    expect(out[0]!.replies.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(meta.posts()).toEqual([]);
  });

  it('lista todos tus vídeos paginando', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...media[0]!, id: `m${i}` }));
    const meta = createFakeMeta({ igUserId: IG_USER_ID, username: OWN_USERNAME, media: many, threads: {}, pageSize: 2 });
    const read = createReadClient({ graph: graphFor(meta.fetch), igUserId: IG_USER_ID });
    const ids = [];
    for await (const m of read.listMedia()) ids.push(m.id);
    expect(ids).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(meta.calls.every((c) => c.path === `/${IG_USER_ID}/media`)).toBe(true);
  });
});
