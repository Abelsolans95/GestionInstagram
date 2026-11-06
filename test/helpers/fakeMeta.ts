import type { FetchLike } from '../../src/meta/http.js';
import type { IgComment, IgMedia } from '../../src/meta/types.js';

/**
 * Graph API de Instagram falsa: responde a las rutas GET que usamos y registra TODAS las
 * peticiones (método y ruta) para poder comprobar, por ejemplo, que la importación no hace POST.
 */
export interface FakeThread {
  comment: IgComment;
  replies?: IgComment[];
}

export interface FakeMetaOptions {
  igUserId: string;
  username: string;
  media: IgMedia[];
  threads: Record<string, FakeThread[]>;
  /** Comentarios sueltos accesibles por GET /{id} (además de los de threads). */
  comments?: IgComment[];
  pageSize?: number;
  /** Respuestas incluidas en la expansión replies{...} antes de paginar. */
  expandedReplies?: number;
  rejectFields?: string[];
  failTimes?: Record<string, number>;
}

export interface RecordedCall {
  method: string;
  path: string;
  params: Record<string, string>;
  body?: unknown;
}

export function createFakeMeta(opts: FakeMetaOptions) {
  const calls: RecordedCall[] = [];
  const pageSize = opts.pageSize ?? 50;
  const failTimes = { ...(opts.failTimes ?? {}) };
  let postCounter = 0;

  const allComments = new Map<string, IgComment>();
  for (const threads of Object.values(opts.threads)) {
    for (const t of threads) {
      allComments.set(t.comment.id, t.comment);
      for (const r of t.replies ?? []) allComments.set(r.id, { ...r, parent_id: t.comment.id });
    }
  }
  for (const c of opts.comments ?? []) allComments.set(c.id, c);

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function page<T>(items: T[], params: Record<string, string>, size = pageSize) {
    const start = params.after ? Number(params.after) : 0;
    const limit = Math.min(Number(params.limit ?? size), size);
    const data = items.slice(start, start + limit);
    const next = start + limit < items.length ? String(start + limit) : null;
    return {
      data,
      ...(next
        ? { paging: { cursors: { after: next }, next: `https://graph.instagram.com/next?after=${next}` } }
        : {}),
    };
  }

  function pick<T extends object>(obj: T, fields: string | undefined): Partial<T> {
    if (!fields) return obj;
    const names = fields.replace(/\{[^}]*\}/g, '').split(',').map((f) => f.trim());
    const out: Record<string, unknown> = {};
    for (const n of names) if (n in obj) out[n] = (obj as Record<string, unknown>)[n];
    return out as Partial<T>;
  }

  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const params = Object.fromEntries(u.searchParams.entries());
    const method = (init.method ?? 'GET').toUpperCase();
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, '/');
    calls.push({ method, path, params, ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}) });

    const key = `${method} ${path}`;
    if (failTimes[key]) {
      failTimes[key]--;
      return json({ error: { message: 'boom', code: 2, is_transient: true } }, 500);
    }
    if (opts.rejectFields?.some((f) => params.fields?.split(/[,{}]/).includes(f))) {
      return json({ error: { message: '(#100) Tried accessing nonexisting field', code: 100 } }, 400);
    }

    if (method === 'POST') {
      // La Graph API real crearía un comentario. Lo registramos y devolvemos un id.
      return json({ id: `reply-${++postCounter}` });
    }

    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'refresh_access_token') {
      return json({ access_token: 'refreshed-token', token_type: 'bearer', expires_in: 5183944 });
    }
    if (parts[0] === 'me') return json({ user_id: opts.igUserId, username: opts.username });
    // Login unificado: la cuenta se lee con GET /{ig-user-id}
    if (parts.length === 1 && parts[0] === opts.igUserId) return json({ id: opts.igUserId, username: opts.username });
    if (parts.length === 2 && parts[0] === opts.igUserId && parts[1] === 'media') {
      return json(page(opts.media.map((m) => pick(m, params.fields)), params));
    }
    if (parts.length === 2 && parts[1] === 'comments') {
      const threads = opts.threads[parts[0]!] ?? [];
      const expanded = opts.expandedReplies ?? 50;
      return json(
        page(
          threads.map((t) => {
            const replies = (t.replies ?? []).map((r) => ({ ...r, parent_id: t.comment.id }));
            return {
              ...pick(t.comment, params.fields),
              ...(replies.length
                ? {
                    replies: {
                      data: replies.slice(0, expanded),
                      ...(replies.length > expanded
                        ? { paging: { cursors: { after: String(expanded) }, next: 'https://graph.instagram.com/x?after=' + expanded } }
                        : {}),
                    },
                  }
                : {}),
            };
          }),
          params,
        ),
      );
    }
    if (parts.length === 2 && parts[1] === 'replies') {
      for (const threads of Object.values(opts.threads)) {
        const t = threads.find((x) => x.comment.id === parts[0]);
        if (t) {
          const replies = (t.replies ?? []).map((r) => ({ ...r, parent_id: t.comment.id }));
          return json(page(replies, params));
        }
      }
      return json({ data: [] });
    }
    if (parts.length === 1) {
      const m = opts.media.find((x) => x.id === parts[0]);
      if (m) return json(pick(m, params.fields));
      const c = allComments.get(parts[0]!);
      if (c) return json(pick(c, params.fields));
      return json({ error: { message: 'Unsupported get request', code: 100 } }, 400);
    }
    return json({ error: { message: `ruta no simulada: ${path}` } }, 404);
  };

  return {
    fetch: fetchImpl,
    calls,
    posts: () => calls.filter((c) => c.method !== 'GET'),
  };
}
