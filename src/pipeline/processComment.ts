import { getComment, updateComment, type CommentRow } from '../db/comments.js';
import type { CommentProcessor, ProcessOutcome } from '../worker/replyWorker.js';
import { ensureMedia, ensureQuestion, getOwnIdentity, type AnalysisDeps, type MediaView } from './context.js';
import { extractAndStore, type CommentForAnalysis } from './extraction.js';
import { hasPrompt } from '../llm/prompts.js';
import { checkSpam, isOwnComment, sameTextCount, type OwnIdentity } from './filters.js';
import { errorMessage } from './log.js';

/** Paso de respuesta (fase e): decide si se responde, genera el texto y lo deja listo. */
export type ReplyStep = (ctx: ReplyStepContext) => Promise<ProcessOutcome>;

export interface ReplyStepContext {
  row: CommentRow;
  media: MediaView;
  threadId: string;
  parentId: string | null;
  parent: { username: string | null; text: string } | null;
  hidden: boolean;
  label: string | null;
  extractError: string | null;
}

export interface ProcessorDeps extends AnalysisDeps {
  replyStep: ReplyStep;
  /** Tus otras cuentas: sus comentarios tampoco se responden ni se analizan. */
  otherOwnAccounts?: () => OwnIdentity[];
}

/**
 * Procesa un comentario de la cola: extracción (siempre) → filtros → respuesta.
 * Comentarios propios, de vídeos ajenos y spam: ni extracción ni respuesta.
 */
export function createCommentProcessor(deps: ProcessorDeps): CommentProcessor {
  return async (row) => {
    // Un comentario importado no se responde nunca (no debería llegar aquí: no se encola).
    if (row.source === 'import' || row.status === 'imported') {
      return { status: 'skipped', decision: 'imported', reason: 'comentario importado: nunca se responde' };
    }

    const own = await getOwnIdentity(deps);
    const isMine = (c: { igUserId: string | null; username: string | null }) =>
      isOwnComment(c, own) || (deps.otherOwnAccounts?.() ?? []).some((o) => isOwnComment(c, o));
    if (isMine({ igUserId: row.ig_user_id, username: row.username })) {
      return {
        status: 'skipped',
        decision: 'own_comment',
        reason: 'comentario de tu propia cuenta',
        patch: { extract_status: 'skipped' },
      };
    }

    // Hilo: si el payload no traía parent_id (el ejemplo de Instagram Login no lo incluye),
    // leemos el comentario para saber si es una respuesta y a qué comentario principal pertenece.
    let { parent_id: parentId, username, text, commented_at: commentedAt } = row;
    let hidden = false;
    if (!row.parent_checked || !username) {
      const c = await deps.read.getComment(row.comment_id);
      parentId = c.parent_id ?? parentId ?? null;
      hidden = c.hidden === true;
      username = (username ?? c.username ?? c.from?.username ?? null)?.toLowerCase() ?? null;
      text = text || c.text || '';
      const ts = c.timestamp ? Date.parse(c.timestamp) : NaN;
      if (!Number.isNaN(ts)) commentedAt = ts;
      updateComment(deps.db, row.comment_id, {
        parent_id: parentId,
        parent_checked: 1,
        thread_id: parentId ?? row.comment_id,
        username,
        text,
        commented_at: commentedAt,
        ig_user_id: row.ig_user_id ?? c.from?.id ?? null,
      });
      if (isMine({ igUserId: row.ig_user_id ?? c.from?.id ?? null, username })) {
        return { status: 'skipped', decision: 'own_comment', reason: 'comentario de tu propia cuenta', patch: { extract_status: 'skipped' } };
      }
    }
    const threadId = parentId ?? row.comment_id;
    const current: CommentRow = { ...row, parent_id: parentId, thread_id: threadId, username, text, commented_at: commentedAt };

    let media = await ensureMedia(deps, row.media_id, { own });
    if (media.isOwn === false) {
      return {
        status: 'skipped',
        decision: 'not_own_media',
        reason: 'comentario en un vídeo que no es tuyo (p. ej. una mención)',
        patch: { extract_status: 'skipped' },
      };
    }
    media = await ensureQuestion(deps, media);

    const spam = checkSpam(text, {
      lists: deps.lists,
      sameTextCount: username ? sameTextCount(deps.db, username, text, row.comment_id) : 0,
    });
    if (spam.isSpam) {
      return { status: 'skipped', decision: 'spam', reason: spam.reason, patch: { extract_status: 'skipped' } };
    }

    // Contexto del comentario padre (si es una respuesta dentro de un hilo).
    let parent: ReplyStepContext['parent'] = null;
    if (parentId) {
      const p = getComment(deps.db, parentId);
      if (p) {
        parent = { username: p.username, text: p.text };
      } else {
        try {
          const pc = await deps.read.getComment(parentId);
          parent = { username: pc.username ?? pc.from?.username ?? null, text: pc.text ?? '' };
        } catch (err) {
          deps.logger.warn({ parent_id: parentId, err: errorMessage(err) }, 'no se pudo leer el comentario padre');
        }
      }
    }

    // Extracción: siempre. Si falla, se registra y se sigue con la respuesta.
    let label: string | null = null;
    let extractError: string | null = null;
    const input: CommentForAnalysis = {
      commentId: row.comment_id,
      accountId: deps.igUserId,
      mediaId: row.media_id,
      username,
      igUserId: row.ig_user_id,
      text,
      commentedAt,
      parent,
    };
    if (!hasPrompt(deps.prompts, 'extract')) {
      // Cuenta sin prompt de análisis: solo se responde.
      updateComment(deps.db, row.comment_id, { extract_status: 'skipped' });
    } else {
      try {
        const r = await extractAndStore(deps, input, media);
        label = r.answer_label;
      } catch (err) {
        extractError = `extracción: ${errorMessage(err)}`;
        updateComment(deps.db, row.comment_id, { extract_status: 'failed', last_error: extractError });
      }
    }

    const out = await deps.replyStep({ row: current, media, threadId, parentId, parent, hidden, label, extractError });
    return { ...out, label: out.label ?? label, error: out.error ?? extractError };
  };
}
