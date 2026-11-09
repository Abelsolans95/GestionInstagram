/**
 * Cliente de LECTURA de la Graph API de Instagram. Solo hace peticiones GET.
 * Lo usan el worker, la importación y los comandos CLI. No puede publicar nada:
 * para eso existe writeClient.ts, que solo usa el publicador del worker de respuestas.
 */
import { graphGet, isMissingObjectError, MetaApiError, type GraphContext } from './http.js';
import type { IgComment, IgMe, IgMedia, IgPage, IgThread } from './types.js';

export interface ReadClient {
  getMe(): Promise<IgMe>;
  getMedia(mediaId: string): Promise<IgMedia>;
  getComment(commentId: string): Promise<IgComment>;
  listMedia(): AsyncGenerator<IgMedia>;
  /** Comentarios principales del vídeo, cada uno con todas sus respuestas (paginando). */
  listThreads(mediaId: string): AsyncGenerator<IgThread>;
  /**
   * Solo los comentarios principales, sin pedir las respuestas dentro (segunda pasada de la
   * importación cuando la primera devuelve menos comentarios de los que dice Instagram).
   */
  listTopLevelComments(mediaId: string): AsyncGenerator<IgComment>;
  /** Comentarios del vídeo según Instagram (comments_count, incluye respuestas). null si no se puede leer. */
  getCommentsCount(mediaId: string): Promise<number | null>;
  listReplies(commentId: string): AsyncGenerator<IgComment>;
  /** Comentarios principales del vídeo con sus me gusta (like_count), para contar votos. */
  listCommentLikes(mediaId: string): Promise<IgComment[]>;
}

const PAGE_LIMIT = 50; // máximo documentado para /comments

// Campos que pedimos. Los "opcionales" se quitan si Meta responde que no existen (código 100):
// la referencia de IG Media dice que `caption` es solo para Facebook Login, aunque el changelog
// indica que se devuelve también en graph.instagram.com. Lo pedimos y, si falla, seguimos sin él.
const MEDIA_REQUIRED = ['id', 'permalink', 'shortcode', 'timestamp', 'media_type'];
const MEDIA_OPTIONAL = ['caption', 'owner', 'username'];
const COMMENT_REQUIRED = ['id', 'text', 'timestamp', 'username'];
const COMMENT_OPTIONAL = ['from', 'parent_id', 'hidden', 'media'];

function isUnknownFieldError(err: unknown): boolean {
  return err instanceof MetaApiError && err.status === 400 && err.code === 100;
}


export interface ReadClientOptions {
  graph: GraphContext;
  igUserId: string;
  /**
   * unified: con el token de usuario del sistema, /me es ese usuario del sistema y no tu cuenta,
   * así que tu cuenta se lee con GET /{IG_USER_ID}. instagram: GET /me?fields=user_id,username.
   */
  login?: 'unified' | 'instagram';
  onWarning?: (msg: string, data?: Record<string, unknown>) => void;
}

export function createReadClient(opts: ReadClientOptions): ReadClient {
  const { graph, igUserId } = opts;
  const warn = opts.onWarning ?? (() => {});
  // Recordamos si un campo opcional no está disponible para no volver a pedirlo.
  const degraded = { media: false, comment: false };

  const mediaFields = () =>
    (degraded.media ? MEDIA_REQUIRED : [...MEDIA_REQUIRED, ...MEDIA_OPTIONAL]).join(',');
  const commentFields = () =>
    (degraded.comment ? COMMENT_REQUIRED : [...COMMENT_REQUIRED, ...COMMENT_OPTIONAL]).join(',');

  async function getWithFallback<T>(
    kind: 'media' | 'comment',
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!degraded[kind] && isUnknownFieldError(err) && !isMissingObjectError(err)) {
        degraded[kind] = true;
        try {
          const res = await call();
          warn(`Meta rechaza algún campo opcional de ${kind}; se sigue sin ellos`, {
            optional: kind === 'media' ? MEDIA_OPTIONAL : COMMENT_OPTIONAL,
            error: (err as Error).message,
          });
          return res;
        } catch (again) {
          // Tampoco sin los opcionales: no era por los campos (p. ej. otra cuenta no puede leerlo).
          degraded[kind] = false;
          throw again;
        }
      }
      throw err;
    }
  }

  async function* paginate<T>(path: string, params: Record<string, string | number>): AsyncGenerator<T> {
    let after: string | undefined;
    for (;;) {
      const page = await graphGet<IgPage<T>>(graph, path, { ...params, ...(after ? { after } : {}) });
      for (const item of page.data ?? []) yield item;
      const next = page.paging?.next;
      if (!next) return;
      after = page.paging?.cursors?.after ?? new URL(next).searchParams.get('after') ?? undefined;
      if (!after) return;
    }
  }

  async function* listReplies(commentId: string): AsyncGenerator<IgComment> {
    yield* paginate<IgComment>(`${commentId}/replies`, { fields: commentFields(), limit: PAGE_LIMIT });
  }

  return {
    getMe: async () => {
      if ((opts.login ?? 'unified') === 'instagram') {
        return graphGet<IgMe>(graph, 'me', { fields: 'user_id,username' });
      }
      const u = await graphGet<{ id: string; username?: string }>(graph, igUserId, { fields: 'id,username' });
      return { user_id: u.id, username: u.username ?? '' };
    },

    getMedia: (mediaId) =>
      getWithFallback('media', () => graphGet<IgMedia>(graph, mediaId, { fields: mediaFields() })),

    getComment: (commentId) =>
      getWithFallback('comment', () =>
        graphGet<IgComment>(graph, commentId, { fields: commentFields() }),
      ),

    async *listMedia() {
      // Probamos los campos con la primera página; si alguno no existe, seguimos sin él.
      const first = await getWithFallback('media', () =>
        graphGet<IgPage<IgMedia>>(graph, `${igUserId}/media`, { fields: mediaFields(), limit: 50 }),
      );
      for (const m of first.data ?? []) yield m;
      let after = first.paging?.next ? first.paging.cursors?.after : undefined;
      if (!after) return;
      yield* paginate<IgMedia>(`${igUserId}/media`, { fields: mediaFields(), limit: 50, after });
    },

    // Petición aparte para no arriesgar el resto de campos del vídeo si Meta no lo diera.
    async getCommentsCount(mediaId) {
      try {
        const m = await graphGet<IgMedia>(graph, mediaId, { fields: 'id,comments_count' });
        return typeof m.comments_count === 'number' ? m.comments_count : null;
      } catch (err) {
        warn('no se pudo leer comments_count', { media_id: mediaId, error: (err as Error).message });
        return null;
      }
    },

    async *listTopLevelComments(mediaId) {
      yield* paginate<IgComment>(`${mediaId}/comments`, { fields: commentFields(), limit: PAGE_LIMIT });
    },

    async *listThreads(mediaId) {
      const fields = () => {
        const f = commentFields();
        return `${f},replies{${f}}`;
      };
      const first = await getWithFallback('comment', () =>
        graphGet<IgPage<IgComment>>(graph, `${mediaId}/comments`, { fields: fields(), limit: PAGE_LIMIT }),
      );
      const pages = (async function* () {
        yield first;
        let page = first;
        while (page.paging?.next) {
          const after =
            page.paging.cursors?.after ?? new URL(page.paging.next).searchParams.get('after');
          if (!after) return;
          page = await graphGet<IgPage<IgComment>>(graph, `${mediaId}/comments`, {
            fields: fields(),
            limit: PAGE_LIMIT,
            after,
          });
          yield page;
        }
      })();
      for await (const page of pages) {
        for (const comment of page.data ?? []) {
          const replies = [...(comment.replies?.data ?? [])];
          // Si las respuestas expandidas vienen paginadas, pedimos el resto por /replies.
          if (comment.replies?.paging?.next) {
            const seen = new Set(replies.map((r) => r.id));
            for await (const r of listReplies(comment.id)) {
              if (!seen.has(r.id)) replies.push(r);
            }
          }
          const { replies: _omit, ...rest } = comment;
          yield { comment: rest, replies };
        }
      }
    },

    listReplies,

    async listCommentLikes(mediaId) {
      // Campos fijos (sin los opcionales degradables): si Meta no diera like_count, mejor un error
      // claro en la página de votos que quitar campos al resto del servicio.
      const out: IgComment[] = [];
      for await (const c of paginate<IgComment>(`${mediaId}/comments`, { fields: 'id,text,username,timestamp,like_count', limit: PAGE_LIMIT })) {
        out.push(c);
      }
      return out;
    },
  };
}
