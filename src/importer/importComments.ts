/**
 * Importación de los comentarios que ya existen en tus vídeos, SIN responderlos.
 *
 * Garantías (comprobadas por test/import.test.ts y test/architecture.test.ts):
 *  - No usa la cola ni el worker de respuestas: llama directamente a la extracción.
 *  - Solo usa el cliente de LECTURA de Meta (GET). No importa ni instancia el de escritura.
 *  - Cada comentario queda en la tabla de procesados con status "imported", que el worker de
 *    respuestas ignora siempre (aunque Meta reenvíe después un webhook de ese comentario).
 *  - Con dryRun no escribe nada en la base de datos: solo muestra lo que extraería.
 */
import { getComment, insertCommentIfNew, updateComment } from '../db/comments.js';
import { hasPrompt } from '../llm/prompts.js';
import type { IgComment, IgMedia } from '../meta/types.js';
import { ensureMedia, ensureQuestion, getOwnIdentity, type AnalysisDeps, type MediaView } from '../pipeline/context.js';
import { analyzeComment, storeAnalysis, type CommentForAnalysis } from '../pipeline/extraction.js';
import { checkSpam, isOwnComment, type OwnIdentity } from '../pipeline/filters.js';
import { errorMessage, logCommentOutcome } from '../pipeline/log.js';

export interface ImportOptions {
  dryRun: boolean;
  /** Solo estos vídeos (por defecto: todos los de la cuenta). */
  mediaIds?: string[];
  /** Máximo de vídeos a recorrer (los más recientes primero). */
  maxMedia?: number;
  /** Salida legible para la consola. */
  print?: (line: string) => void;
  /** Tus otras cuentas: sus comentarios se tratan como propios. */
  otherOwnAccounts?: OwnIdentity[];
}

export interface ImportSummary {
  media: number;
  comments: number;
  imported: number;
  answers: number;
  nonAnswers: number;
  alreadyKnown: number;
  own: number;
  spam: number;
  failed: number;
}

/** La importación real solo se permite con REVIEW_MODE=true (red de seguridad); dry-run siempre. */
export function assertImportAllowed(o: { reviewMode: boolean; dryRun: boolean }): void {
  if (!o.dryRun && !o.reviewMode) {
    throw new Error(
      'Por seguridad la importación solo se ejecuta con REVIEW_MODE=true (o con --dry-run). ' +
        'Activa REVIEW_MODE=true en las variables del servicio y vuelve a lanzarla.',
    );
  }
}

export async function importComments(deps: AnalysisDeps, opts: ImportOptions): Promise<ImportSummary> {
  const { db } = deps;
  const persist = !opts.dryRun;
  const print = opts.print ?? (() => {});
  const now = () => deps.now?.() ?? Date.now();
  const summary: ImportSummary = {
    media: 0,
    comments: 0,
    imported: 0,
    answers: 0,
    nonAnswers: 0,
    alreadyKnown: 0,
    own: 0,
    spam: 0,
    failed: 0,
  };

  const own = await getOwnIdentity(deps, { persist });
  const canAnalyze = hasPrompt(deps.prompts, 'extract');
  if (!canAnalyze) {
    print('Esta cuenta no tiene prompts/cuentas/<cuenta>/extract.md: se registran los comentarios (para no responderlos) sin analizarlos. Cuando lo tenga, analízalos con `pnpm reextract --cuenta <cuenta>`.');
  }

  async function* mediaSource(): AsyncGenerator<IgMedia> {
    if (opts.mediaIds?.length) {
      for (const id of opts.mediaIds) yield await deps.read.getMedia(id);
      return;
    }
    yield* deps.read.listMedia();
  }

  for await (const m of mediaSource()) {
    if (opts.maxMedia !== undefined && summary.media >= opts.maxMedia) break;
    let media = await ensureMedia(deps, m.id, { persist, known: m, own });
    if (media.isOwn === false) continue;
    summary.media++;
    media = await ensureQuestion(deps, media, { persist });
    print(
      `\n▶ ${media.permalink ?? media.mediaId}\n  pregunta: ${media.question ?? '(sin pregunta: fíjala con `pnpm question set` y luego `pnpm reextract`)'}`,
    );

    for await (const thread of deps.read.listThreads(media.mediaId)) {
      await importOne(thread.comment, null, media);
      for (const reply of thread.replies) await importOne(reply, thread.comment, media);
    }
  }
  return summary;

  async function importOne(c: IgComment, parent: IgComment | null, media: MediaView): Promise<void> {
    summary.comments++;
    const started = Date.now();
    const username = (c.username ?? c.from?.username ?? null)?.toLowerCase() ?? null;
    const igUserId = c.from?.id ?? null;
    const text = c.text ?? '';
    const ts = c.timestamp ? Date.parse(c.timestamp) : NaN;
    const commentedAt = Number.isNaN(ts) ? now() : ts;
    const log = (decision: string, extra: { reason?: string; label?: string | null; error?: string } = {}) =>
      logCommentOutcome(deps.logger, {
        comment_id: c.id,
        username,
        origin: 'import',
        decision,
        latency_ms: Date.now() - started,
        dry_run: opts.dryRun || undefined,
        ...extra,
      });

    if (getComment(db, c.id)) {
      summary.alreadyKnown++;
      return;
    }

    const row = {
      commentId: c.id,
      accountId: deps.igUserId,
      mediaId: media.mediaId,
      parentId: parent?.id ?? c.parent_id ?? null,
      parentChecked: true,
      igUserId,
      username,
      text,
      commentedAt,
      source: 'import' as const,
      status: 'imported' as const,
    };

    const skipWith = (decision: 'own_comment' | 'spam', reason: string) => {
      if (persist && insertCommentIfNew(db, row, now())) {
        updateComment(db, c.id, { decision, reason, extract_status: 'skipped' }, now());
      }
      log(decision, { reason });
    };

    const mine = [own as OwnIdentity, ...(opts.otherOwnAccounts ?? [])];
    if (mine.some((o) => isOwnComment({ igUserId, username }, o))) {
      summary.own++;
      return skipWith('own_comment', 'comentario de tu propia cuenta');
    }
    const spam = checkSpam(text, { lists: deps.lists });
    if (spam.isSpam) {
      summary.spam++;
      return skipWith('spam', spam.reason ?? 'spam');
    }

    // Se registra ANTES de llamar a Claude: si mientras tanto llega un webhook de este comentario,
    // el INSERT OR IGNORE de la cola no lo encolará.
    if (persist && !insertCommentIfNew(db, row, now())) {
      summary.alreadyKnown++;
      return;
    }

    // Cuenta sin prompt de análisis: queda registrado como importado (no se responderá), sin análisis.
    if (!canAnalyze) {
      // Sin extract_status: queda pendiente de análisis (`pnpm reextract --cuenta` cuando haya prompt).
      if (persist) updateComment(db, c.id, { decision: 'imported', reason: 'importación (sin análisis en esta cuenta)' }, now());
      summary.imported++;
      log('imported', { reason: 'sin prompt de análisis' });
      return;
    }

    const input: CommentForAnalysis = {
      commentId: c.id,
      accountId: deps.igUserId,
      mediaId: media.mediaId,
      username,
      igUserId,
      text,
      commentedAt,
      parent: parent ? { username: parent.username ?? null, text: parent.text ?? '' } : null,
    };
    try {
      const r = await analyzeComment(deps, input, media);
      if (persist) {
        storeAnalysis(db, input, media, r, now());
        updateComment(db, c.id, { decision: 'imported', reason: 'importación (sin respuesta)' }, now());
      }
      summary.imported++;
      if (r.answers_question) summary.answers++;
      else summary.nonAnswers++;
      print(
        `  @${username ?? '?'}: ${text.replace(/\s+/g, ' ').slice(0, 80)}\n    → ${
          r.answers_question ? `${r.answer_label} (${r.answer})` : 'no responde a la pregunta'
        }${r.character_name ? ` · personaje: ${r.character_name}` : ''}`,
      );
      log('imported', { label: r.answer_label });
    } catch (err) {
      summary.failed++;
      const msg = errorMessage(err);
      if (persist) {
        updateComment(db, c.id, { decision: 'imported', extract_status: 'failed', last_error: msg }, now());
      }
      print(`  @${username ?? '?'}: ✖ error en la extracción: ${msg}`);
      log('extract_failed', { error: msg });
    }
  }
}
