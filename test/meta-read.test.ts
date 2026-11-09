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

  it('lee los me gusta de los comentarios principales paginando, solo con GET', async () => {
    const threads = {
      m1: [5, 0, 12].map((likes, i) => ({ comment: { id: `c${i}`, text: `t${i}`, username: `u${i}`, like_count: likes }, replies: [] })),
    };
    const meta = createFakeMeta({ igUserId: IG_USER_ID, username: OWN_USERNAME, media, threads, pageSize: 2 });
    const read = createReadClient({ graph: graphFor(meta.fetch), igUserId: IG_USER_ID });
    const out = await read.listCommentLikes('m1');
    expect(out.map((c) => [c.id, c.like_count])).toEqual([['c0', 5], ['c1', 0], ['c2', 12]]);
    expect(meta.calls.every((c) => c.path === '/m1/comments')).toBe(true);
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

describe('login unificado vs login de Instagram', () => {
  it('unified: tu cuenta se lee con GET /{IG_USER_ID} (no con /me)', async () => {
    const meta = createFakeMeta({ igUserId: IG_USER_ID, username: OWN_USERNAME, media: [], threads: {} });
    const read = createReadClient({ graph: graphFor(meta.fetch), igUserId: IG_USER_ID, login: 'unified' });
    expect(await read.getMe()).toEqual({ user_id: IG_USER_ID, username: OWN_USERNAME });
    expect(meta.calls.map((c) => c.path)).toEqual([`/${IG_USER_ID}`]);
  });

  it('instagram: usa GET /me?fields=user_id,username', async () => {
    const meta = createFakeMeta({ igUserId: IG_USER_ID, username: OWN_USERNAME, media: [], threads: {} });
    const read = createReadClient({ graph: graphFor(meta.fetch), igUserId: IG_USER_ID, login: 'instagram' });
    await read.getMe();
    expect(meta.calls[0]).toMatchObject({ path: '/me', params: { fields: 'user_id,username' } });
  });
});

describe('los tokens nunca acaban en los mensajes de error', () => {
  it('quita el token aunque Meta lo repita en su mensaje ("Malformed access token …")', async () => {
    const token = 'EAAhz4exampleTOKEN1234567890abcdefXYZ';
    const f: FetchLike = async (u) => {
      const t = new URL(u).searchParams.get('access_token');
      return new Response(JSON.stringify({ error: { message: `Malformed access token ${t}`, code: 190 } }), { status: 400 });
    };
    const err = (await graphGet({ ...graphFor(f), getAccessToken: () => `${token}\nIG_USER_ID=1784` }, 'me').catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('Malformed access token');
    expect(err.message).not.toContain('EAAhz4');
  });

  it('redacta también tokens con aspecto de token de Meta o de Instagram', async () => {
    const { redactSecrets } = await import('../src/meta/http.js');
    expect(redactSecrets('x EAABsbCS1iHgBAZBexampletoken1234567 y IGAAexampletoken1234567890abc z')).toBe('x [REDACTED] y [REDACTED] z');
  });
});

describe('radar: datos públicos de otra cuenta (Business Discovery)', () => {
  it('pide a tu cuenta los datos de la otra por su @, con sus últimos reels; solo GET', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(url);
      expect(init.method ?? 'GET').toBe('GET');
      return new Response(
        JSON.stringify({ id: IG_USER_ID, business_discovery: { username: 'otra_cuenta', followers_count: 1200, media: { data: [{ id: 'x1', media_type: 'VIDEO', like_count: 300, comments_count: 40 }] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const read = createReadClient({ graph: graphFor(fetchImpl), igUserId: IG_USER_ID });
    const bd = await read.businessDiscovery('@otra_cuenta', 10);
    expect(bd).toMatchObject({ username: 'otra_cuenta', followers_count: 1200 });
    expect(bd.media?.data[0]).toMatchObject({ like_count: 300, comments_count: 40 });
    const url = decodeURIComponent(urls[0]!);
    expect(url).toContain(`/${IG_USER_ID}?`);
    expect(url).toContain('business_discovery.username(otra_cuenta){username,name,followers_count,media_count,media.limit(10){');
    expect(url).toContain('like_count,comments_count');
  });

  it('un @ con caracteres raros no llega a Meta', async () => {
    let calls = 0;
    const read = createReadClient({ graph: graphFor(async () => (calls++, new Response('{}'))), igUserId: IG_USER_ID });
    await expect(read.businessDiscovery('a){x}')).rejects.toThrow(/no es un usuario de Instagram válido/);
    expect(calls).toBe(0);
  });
});
