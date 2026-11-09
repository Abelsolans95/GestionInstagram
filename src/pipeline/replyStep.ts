import { recentRepliesInMedia } from '../db/comments.js';
import type { DB } from '../db/index.js';
import { LlmRefusalError, type LlmClient } from '../llm/claude.js';
import type { PromptStore } from '../llm/prompts.js';
import { generateReply } from '../llm/reply.js';
import type { Logger } from '../logger.js';
import type { ProcessOutcome } from '../worker/replyWorker.js';
import { autoRepliesInThread, complaintRepliesForUser, findBlockedTerm, hasLink, type FilterLists } from './filters.js';
import type { ReplyStep } from './processComment.js';
import { isLettersOnly } from './text.js';

export interface ReplySettings {
  delayMinSec: number;
  delayMaxSec: number;
  reviewMode: boolean;
  /** Cuentas (usuario sin @ en minúscula, o ID) que pasan por revisión aunque reviewMode sea false. */
  reviewAccounts?: string[];
  /** 0 = sin límite de antigüedad. */
  maxAgeHours: number;
}

export interface ReplyStepDeps {
  db: DB;
  llm: LlmClient;
  prompts: PromptStore;
  lists: FilterLists;
  logger: Logger;
  settings: ReplySettings;
  /** Cuenta que responde (las quejas se cuentan por cuenta). */
  accountId?: string;
  now?: () => number;
  random?: () => number;
}

/** Máximo de respuestas automáticas a un mismo usuario en un mismo hilo en 24 h (evita bucles). */
export const MAX_AUTO_REPLIES_PER_THREAD = 2;

/** Delay aleatorio uniforme en [min, max] segundos. */
export function randomDelayMs(s: Pick<ReplySettings, 'delayMinSec' | 'delayMaxSec'>, random = Math.random): number {
  return Math.round((s.delayMinSec + random() * (s.delayMaxSec - s.delayMinSec)) * 1000);
}

const skip = (decision: string, reason: string, extra: Partial<ProcessOutcome> = {}): ProcessOutcome => ({
  status: 'skipped',
  decision,
  reason,
  ...extra,
});

/**
 * Filtros de respuesta + generación con Claude. Con REVIEW_MODE la respuesta queda en
 * 'pending_review'; si no, 'scheduled' con publish_at = ahora + delay aleatorio.
 */
export function createReplyStep(deps: ReplyStepDeps): ReplyStep {
  const now = deps.now ?? Date.now;
  return async ({ row, media, threadId, parentId, parent, hidden, label }) => {
    if (row.source === 'import' || row.status === 'imported') {
      return skip('imported', 'comentario importado: nunca se responde');
    }
    if (hidden) return skip('hidden', 'comentario oculto: Meta no permite responderlo');
    const { maxAgeHours } = deps.settings;
    if (maxAgeHours > 0 && now() - row.commented_at > maxAgeHours * 3_600_000) {
      return skip('too_old', `comentario de hace más de ${maxAgeHours} h`);
    }
    if (hasLink(row.text)) return skip('has_link', 'el comentario lleva enlaces');
    if (isLettersOnly(row.text)) return skip('letters_only', 'solo letras sueltas ("A", "Aa", "Apapapa"): no se responde');
    const blocked = findBlockedTerm(row.text, deps.lists);
    if (blocked) return skip('blocked_term', `término bloqueado: ${blocked}`);
    if (!row.username) return skip('no_username', 'no se conoce el @usuario del autor');
    const already = autoRepliesInThread(deps.db, threadId, row.username, row.comment_id, now());
    if (already >= MAX_AUTO_REPLIES_PER_THREAD) {
      return skip('thread_limit', `ya hay ${already} respuestas automáticas a @${row.username} en este hilo en 24 h`);
    }

    let v;
    try {
      v = await generateReply(deps.llm, deps.prompts, {
        username: row.username,
        text: row.text,
        caption: media.caption,
        question: media.question,
        parent,
        answerLabel: label,
        recentReplies: recentRepliesInMedia(deps.db, media.mediaId, row.comment_id),
      });
    } catch (err) {
      if (err instanceof LlmRefusalError) return skip('llm_refusal', err.message);
      throw err;
    }
    if (!v.ok) {
      deps.logger.warn(
        { comment_id: row.comment_id, error: v.error, raw: v.raw.slice(0, 500) },
        'salida del modelo descartada',
      );
      return skip('invalid_llm_output', `salida descartada: ${v.error}`);
    }
    // Quejas de que no sale: solo se responde una vez a cada persona.
    if (v.complaint && complaintRepliesForUser(deps.db, row.username, row.comment_id, deps.accountId ?? row.account_id) > 0) {
      return skip('complaint_repeat', 'queja de que no sale: ya se le respondió una vez');
    }
    if (v.reply === null) return skip('llm_null', `el modelo no responde: ${v.reason}`);

    // Instagram solo admite respuestas a comentarios principales: en un hilo se publica sobre el padre.
    const target = parentId ?? row.comment_id;
    const patch = {
      reply_text: v.reply,
      reply_reason: v.reason,
      reply_target_id: target,
      reply_kind: v.complaint ? 'complaint' : null,
    };
    if (deps.settings.reviewMode) {
      return { status: 'pending_review', decision: 'reply', reason: v.reason, patch };
    }
    return {
      status: 'scheduled',
      decision: 'reply',
      reason: v.reason,
      patch: { ...patch, publish_at: now() + randomDelayMs(deps.settings, deps.random) },
    };
  };
}
