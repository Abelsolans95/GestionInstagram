import { deleteAnswer, labelsForMedia, refreshParticipant, saveAnswer } from '../db/analysis.js';
import { updateComment } from '../db/comments.js';
import type { DB } from '../db/index.js';
import { extractFromComment, type ExtractResult } from '../llm/extract.js';
import type { AnalysisDeps, MediaView } from './context.js';

/**
 * Extracción por comentario (llamada a Claude separada de la de respuesta). La usan tanto el
 * worker como la importación, que la llama directamente sin pasar por la cola.
 */
export interface CommentForAnalysis {
  commentId: string;
  /** Cuenta del vídeo (para la ficha del participante). Si falta, la del comentario guardado. */
  accountId?: string | null;
  mediaId: string;
  username: string | null;
  igUserId: string | null;
  text: string;
  commentedAt: number;
  parent?: { username: string | null; text: string } | null;
}

export async function analyzeComment(
  deps: AnalysisDeps,
  c: CommentForAnalysis,
  media: MediaView,
): Promise<ExtractResult> {
  return extractFromComment(deps.llm, deps.prompts, {
    question: media.question,
    caption: media.caption,
    existingLabels: labelsForMedia(deps.db, c.mediaId),
    username: c.username,
    text: c.text,
    parent: c.parent ?? null,
  });
}

/** Guarda el resultado: columnas del comentario, tabla answers y ficha del participante. */
export function storeAnalysis(
  db: DB,
  c: CommentForAnalysis,
  media: MediaView,
  r: ExtractResult,
  now = Date.now(),
): void {
  db.transaction(() => {
    updateComment(
      db,
      c.commentId,
      {
        extract_status: 'done',
        extracted_at: now,
        answers_question: r.answers_question ? 1 : 0,
        answer: r.answer,
        answer_label: r.answer_label,
        character_name: r.character_name,
      },
      now,
    );
    const username = c.username?.toLowerCase();
    if (r.answers_question && username) {
      saveAnswer(db, {
        mediaId: c.mediaId,
        question: media.question,
        username,
        answer: r.answer,
        answerLabel: r.answer_label,
        commentId: c.commentId,
        rawText: c.text,
        createdAt: c.commentedAt,
      });
    } else {
      deleteAnswer(db, c.commentId);
    }
    if (username) {
      const stored = db.prepare('SELECT account_id FROM comments WHERE comment_id = ?').get(c.commentId) as
        | { account_id: string | null }
        | undefined;
      const media = db.prepare('SELECT account_id FROM media WHERE media_id = ? AND is_own = 1').get(c.mediaId) as
        | { account_id: string | null }
        | undefined;
      const accountId = c.accountId ?? stored?.account_id ?? media?.account_id ?? null;
      if (accountId && stored && !stored.account_id) updateComment(db, c.commentId, { account_id: accountId }, now);
      if (accountId) refreshParticipant(db, accountId, username);
    }
  })();
}

export async function extractAndStore(
  deps: AnalysisDeps,
  c: CommentForAnalysis,
  media: MediaView,
): Promise<ExtractResult> {
  const result = await analyzeComment(deps, c, media);
  storeAnalysis(deps.db, { ...c, accountId: c.accountId ?? deps.igUserId }, media, result, deps.now?.());
  return result;
}
