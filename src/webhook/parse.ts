/**
 * Convierte el payload de un webhook de Instagram en eventos de comentario.
 *
 * La documentación de Meta muestra dos formas distintas para la notificación `comments`:
 *  - Facebook Login:  entry[].changes[] = { field, value: { from, comment_id, parent_id, text, media } }
 *  - Instagram Login: entry[] = { field, value: { id, from, text, media } }   (sin `changes` ni `parent_id`)
 * Aceptamos ambas, y también el id en `value.id` o `value.comment_id`, para no depender de
 * cuál de los dos ejemplos refleja lo que envía Meta realmente.
 *
 * `parentId` es null cuando el payload no trae `parent_id`. Como el ejemplo de Instagram Login
 * no lo incluye, null significa "no lo sabemos": el worker lo confirmará leyendo el comentario.
 */

export interface CommentEvent {
  commentId: string;
  mediaId: string;
  text: string;
  fromId: string | null;
  fromUsername: string | null;
  parentId: string | null;
  mediaProductType: string | null;
  /** ID de la cuenta profesional que recibe la notificación (entry.id). */
  accountId: string | null;
  /** entry.time: momento en que Meta envió la notificación (epoch en segundos). */
  sentAt: number | null;
}

export interface IgnoredChange {
  field: string | null;
  reason: string;
}

export interface ParsedWebhook {
  comments: CommentEvent[];
  ignored: IgnoredChange[];
}

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Los IDs de la Graph API son strings, pero aceptamos números por si acaso. */
function id(x: unknown): string | null {
  if (typeof x === 'string' && x.trim() !== '') return x.trim();
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return null;
}

function str(x: unknown): string | null {
  return typeof x === 'string' ? x : null;
}

function changesOf(entry: Obj): Obj[] {
  if (Array.isArray(entry.changes)) return entry.changes.filter(isObj);
  if (typeof entry.field === 'string') return [{ field: entry.field, value: entry.value }];
  return [];
}

export function parseWebhookPayload(payload: unknown): ParsedWebhook {
  const comments: CommentEvent[] = [];
  const ignored: IgnoredChange[] = [];
  // En la documentación los ejemplos aparecen envueltos en un array; aceptamos ambas cosas.
  const roots = Array.isArray(payload) ? payload : [payload];

  for (const root of roots) {
    if (!isObj(root)) {
      ignored.push({ field: null, reason: 'payload no es un objeto' });
      continue;
    }
    if (root.object !== 'instagram') {
      ignored.push({ field: null, reason: `object=${String(root.object)}` });
      continue;
    }
    const entries = Array.isArray(root.entry) ? root.entry.filter(isObj) : [];
    for (const entry of entries) {
      const accountId = id(entry.id);
      const sentAt = typeof entry.time === 'number' ? entry.time : null;
      const changes = changesOf(entry);
      if (changes.length === 0) {
        ignored.push({ field: null, reason: 'entry sin changes ni field' });
      }
      for (const change of changes) {
        const field = str(change.field);
        if (field !== 'comments') {
          // live_comments: la API no permite responder en directos, así que no lo procesamos.
          ignored.push({ field, reason: 'campo no gestionado' });
          continue;
        }
        const value = isObj(change.value) ? change.value : null;
        const media = value && isObj(value.media) ? value.media : null;
        const from = value && isObj(value.from) ? value.from : null;
        const commentId = value ? (id(value.id) ?? id(value.comment_id)) : null;
        const mediaId = media ? id(media.id) : null;
        if (!value || !commentId || !mediaId) {
          ignored.push({ field, reason: 'faltan id de comentario o de media' });
          continue;
        }
        comments.push({
          commentId,
          mediaId,
          text: str(value.text) ?? '',
          fromId: from ? id(from.id) : null,
          fromUsername: from ? str(from.username) : null,
          parentId: id(value.parent_id),
          mediaProductType: media ? str(media.media_product_type) : null,
          accountId,
          sentAt,
        });
      }
    }
  }
  return { comments, ignored };
}
