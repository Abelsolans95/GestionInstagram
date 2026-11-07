import type { DB } from '../db/index.js';

/**
 * Conversaciones de un vídeo en Markdown: cada comentario principal con su hilo y tus respuestas
 * marcadas. Sirve para ver cómo respondes tú a mano (p. ej. para ajustar el prompt de respuestas).
 */

interface Row {
  comment_id: string;
  thread: string;
  username: string | null;
  text: string;
  commented_at: number;
  own: number;
  auto: number;
}

/** Texto en una sola línea, tal cual (sin escapes, como el informe .md). */
const line = (text: string) => text.replace(/\s+/g, ' ').trim();

export function mediaConversationsMarkdown(db: DB, mediaId: string): string | null {
  const media = db.prepare('SELECT media_id, permalink, question FROM media WHERE media_id = ?').get(mediaId) as
    | { media_id: string; permalink: string | null; question: string | null }
    | undefined;
  if (!media) return null;

  const rows = db
    .prepare(
      `SELECT c.comment_id, COALESCE(c.parent_id, c.comment_id) AS thread, c.username, c.text, c.commented_at,
              (c.decision = 'own_comment') AS own,
              EXISTS (SELECT 1 FROM comments r WHERE r.reply_comment_id = c.comment_id) AS auto
         FROM comments c
        WHERE c.media_id = ?
        ORDER BY c.commented_at, c.comment_id`,
    )
    .all(mediaId) as Row[];

  // Hilos en orden de su comentario principal; dentro, por fecha.
  const threads = new Map<string, Row[]>();
  for (const r of rows) {
    const t = threads.get(r.thread) ?? [];
    t.push(r);
    threads.set(r.thread, t);
  }
  const ordered = [...threads.values()].map((t) => {
    const root = t.find((r) => r.comment_id === r.thread);
    return root ? [root, ...t.filter((r) => r !== root)] : t;
  });

  const author = (r: Row) => (r.own ? (r.auto ? '**tú (automática):**' : '**tú:**') : `@${line(r.username ?? '?')}:`);
  const answered = ordered.filter((t) => t.some((r) => r.own && t[0] !== r)).length;

  const out: string[] = [`# Conversaciones · ${line(media.question ?? '(sin pregunta)')}`, ''];
  const meta = [`${ordered.length} ${ordered.length === 1 ? 'hilo' : 'hilos'}`, `respondiste en ${answered}`];
  if (media.permalink) meta.push(`vídeo: ${media.permalink}`);
  out.push(meta.join(' · '), '');
  if (ordered.length === 0) out.push('No hay comentarios guardados de este vídeo.');
  for (const t of ordered) {
    const [first, ...rest] = t;
    out.push(`- ${author(first!)} ${line(first!.text)}`);
    for (const r of rest) out.push(`  - ${author(r)} ${line(r.text)}`);
    if (!first!.own && !rest.some((r) => r.own)) out.push('  - (sin respuesta)');
  }
  return out.join('\n') + '\n';
}
