/**
 * Votos con me gusta: en un vídeo publicas un comentario por opción (p. ej. un candidato) y los
 * seguidores votan dándole me gusta. Aquí se leen de Meta, en el momento, los me gusta de tus
 * comentarios principales de ese vídeo y se ordenan.
 */
import type { DB } from '../db/index.js';
import type { ReadClient } from '../meta/readClient.js';
import { esc, nav, page } from './html.js';

export interface VoteOption {
  commentId: string;
  text: string;
  /** null si Meta no devuelve los me gusta de ese comentario. */
  likes: number | null;
}

export interface VotesResult {
  mediaId: string;
  question: string | null;
  permalink: string | null;
  options: VoteOption[];
  readAt: number;
}

export interface VotesDeps {
  read: Pick<ReadClient, 'listCommentLikes'>;
  /** Tu @usuario (en minúscula), para reconocer tus comentarios. */
  ownUsername: () => Promise<string | null>;
}

/** null si el vídeo no está en la base de datos. Lanza si Meta falla. */
export async function buildVotes(db: DB, deps: VotesDeps, mediaId: string, now = Date.now()): Promise<VotesResult | null> {
  const media = db.prepare('SELECT media_id, question, permalink FROM media WHERE media_id = ?').get(mediaId) as
    | { media_id: string; question: string | null; permalink: string | null }
    | undefined;
  if (!media) return null;

  // Tus comentarios: los que ya tenemos guardados como propios y, por si alguno no llegó, los que
  // vienen con tu @usuario.
  const ownIds = new Set(
    (
      db
        .prepare("SELECT comment_id FROM comments WHERE media_id = ? AND decision = 'own_comment' AND parent_id IS NULL")
        .all(mediaId) as { comment_id: string }[]
    ).map((r) => r.comment_id),
  );
  const [comments, own] = await Promise.all([deps.read.listCommentLikes(mediaId), deps.ownUsername()]);
  const options = comments
    .filter((c) => ownIds.has(c.id) || (!!own && c.username?.toLowerCase() === own))
    .map((c) => ({ commentId: c.id, text: c.text ?? '', likes: typeof c.like_count === 'number' ? c.like_count : null }))
    .sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1));
  return { mediaId, question: media.question, permalink: media.permalink, options, readAt: now };
}

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });

export function votesHtml(r: VotesResult, token: string): string {
  const t = encodeURIComponent(token);
  const counted = r.options.filter((o) => o.likes !== null);
  const top = counted[0]?.likes ?? null;
  const winners = top !== null && top > 0 ? counted.filter((o) => o.likes === top) : [];
  const verdict =
    winners.length === 1
      ? `<div class="card">🏆 Va ganando: <b>${esc(winners[0]!.text)}</b> con ${top} me gusta</div>`
      : winners.length > 1
        ? `<div class="card">Empate a ${top} me gusta entre ${winners.length} comentarios</div>`
        : '';
  const list = r.options.length
    ? `<ol>${r.options
        .map(
          (o) =>
            `<li><span class="label">${o.likes === null ? '¿?' : o.likes} me gusta</span> · ${esc(o.text)}</li>`,
        )
        .join('\n')}</ol>`
    : '<p class="muted">No hay comentarios tuyos en este vídeo. Publica uno por opción (p. ej. uno por candidato) y pide que voten dándole me gusta.</p>';
  const missing = r.options.some((o) => o.likes === null)
    ? '<p class="muted">¿? = Instagram no ha devuelto los me gusta de ese comentario.</p>'
    : '';
  return page(
    'Votos',
    `${nav(token)}
<h1>Votos · ${esc(r.question ?? 'vídeo')}</h1>
<p class="muted">Me gusta de los comentarios que publicaste tú en el vídeo, leídos de Instagram a las ${time(r.readAt)}. <a href="/report/${esc(r.mediaId)}/votos?token=${t}">Actualizar</a> · <a href="/report/${esc(r.mediaId)}?token=${t}">volver al informe</a>${r.permalink ? ` · <a href="${esc(r.permalink)}" rel="noreferrer">ver vídeo</a>` : ''}</p>
${verdict}
${list}
${missing}`,
  );
}

export function votesErrorHtml(mediaId: string, token: string, message: string): string {
  const t = encodeURIComponent(token);
  return page(
    'Votos',
    `${nav(token)}
<h1>Votos</h1>
<div class="card">No se han podido leer los me gusta de Instagram: ${esc(message.slice(0, 200))}</div>
<p><a href="/report/${esc(mediaId)}/votos?token=${t}">Reintentar</a></p>`,
  );
}
