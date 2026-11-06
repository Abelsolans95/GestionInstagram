import { getComment, updateComment, type CommentRow } from '../db/comments.js';
import { ensureMedia, ensureQuestion, type AnalysisDeps } from './context.js';
import { analyzeComment, storeAnalysis } from './extraction.js';
import { errorMessage } from './log.js';

export interface ReextractSummary {
  total: number;
  done: number;
  failed: number;
}

/**
 * Vuelve a pasar por la extracción los comentarios ya analizados de un vídeo (p. ej. tras fijar
 * la pregunta a mano). No responde a nadie: solo actualiza el análisis.
 */
export async function reextractMedia(
  deps: AnalysisDeps,
  mediaId: string,
  opts: { onlyFailed?: boolean; print?: (line: string) => void } = {},
): Promise<ReextractSummary> {
  const print = opts.print ?? (() => {});
  let media = await ensureMedia(deps, mediaId);
  media = await ensureQuestion(deps, media);
  const statuses = opts.onlyFailed ? ['failed'] : ['done', 'failed'];
  const rows = deps.db
    .prepare(
      `SELECT * FROM comments WHERE media_id = ? AND extract_status IN (${statuses.map(() => '?').join(',')})
       ORDER BY commented_at`,
    )
    .all(mediaId, ...statuses) as CommentRow[];
  const summary: ReextractSummary = { total: rows.length, done: 0, failed: 0 };
  for (const row of rows) {
    const parent = row.parent_id ? getComment(deps.db, row.parent_id) : undefined;
    const input = {
      commentId: row.comment_id,
      mediaId,
      username: row.username,
      igUserId: row.ig_user_id,
      text: row.text,
      commentedAt: row.commented_at,
      parent: parent ? { username: parent.username, text: parent.text } : null,
    };
    try {
      const r = await analyzeComment(deps, input, media);
      storeAnalysis(deps.db, input, media, r);
      summary.done++;
      print(`  @${row.username}: ${r.answers_question ? r.answer_label : 'no responde'}${r.character_name ? ` · ${r.character_name}` : ''}`);
    } catch (err) {
      summary.failed++;
      updateComment(deps.db, row.comment_id, { extract_status: 'failed', last_error: errorMessage(err) });
      print(`  @${row.username}: ✖ ${errorMessage(err)}`);
    }
  }
  return summary;
}
