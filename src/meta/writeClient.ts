/**
 * Cliente de ESCRITURA de la Graph API de Instagram: lo único que publica en tu cuenta.
 * Solo lo importa el publicador del worker de respuestas (src/worker/publisher.ts); un test de
 * arquitectura falla si cualquier otro módulo lo importa. La importación nunca lo alcanza.
 *
 * Documentación (Comment Moderation, Instagram API con Instagram Login):
 *   POST https://graph.instagram.com/<versión>/<IG_COMMENT_ID>/replies  {"message": "..."}  → {"id"}
 * Solo se puede responder a comentarios principales ("replies to a reply will be added to the
 * top-level comment"), así que en un hilo se publica sobre el comentario padre.
 */
import { graphPost, type GraphContext } from './http.js';

export interface WriteClient {
  replyToComment(commentId: string, message: string): Promise<{ id: string }>;
}

export function createWriteClient(graph: GraphContext): WriteClient {
  return {
    async replyToComment(commentId, message) {
      if (!/^\d+$/.test(commentId)) throw new Error(`id de comentario inválido: ${commentId}`);
      const res = await graphPost<{ id?: string }>(graph, `${commentId}/replies`, { message });
      if (!res.id) throw new Error('Meta no devolvió el id del comentario publicado');
      return { id: res.id };
    },
  };
}
