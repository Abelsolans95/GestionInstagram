import { getMedia, setQuestion, upsertMedia, type MediaRow, type QuestionSource } from '../db/analysis.js';
import { kvGet, kvSet, type DB } from '../db/index.js';
import type { LlmClient } from '../llm/claude.js';
import type { PromptStore } from '../llm/prompts.js';
import { detectQuestion } from '../llm/question.js';
import type { Logger } from '../logger.js';
import { MetaApiError } from '../meta/http.js';
import type { ReadClient } from '../meta/readClient.js';
import type { IgMedia } from '../meta/types.js';
import type { FilterLists, OwnIdentity } from './filters.js';

/**
 * Dependencias del análisis. Solo LECTURA de Meta: la importación usa exactamente esto, por eso
 * aquí no aparece (ni puede aparecer) el cliente de escritura.
 */
export interface AnalysisDeps {
  db: DB;
  read: ReadClient;
  llm: LlmClient;
  prompts: PromptStore;
  lists: FilterLists;
  igUserId: string;
  logger: Logger;
  now?: () => number;
}

export interface MediaView {
  mediaId: string;
  caption: string | null;
  permalink: string | null;
  shortcode: string | null;
  isOwn: boolean | null;
  question: string | null;
  questionSource: QuestionSource | null;
}

const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;

function toView(r: MediaRow): MediaView {
  return {
    mediaId: r.media_id,
    caption: r.caption,
    permalink: r.permalink,
    shortcode: r.shortcode,
    isOwn: r.is_own === null ? null : r.is_own === 1,
    question: r.question,
    questionSource: r.question_source,
  };
}

export function mediaUpsertFromApi(m: IgMedia, own: OwnIdentity) {
  const isOwn = m.owner?.id
    ? m.owner.id === own.userId
    : m.username && own.username
      ? m.username.toLowerCase() === own.username.toLowerCase()
      : null;
  const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
  return {
    mediaId: m.id,
    shortcode: m.shortcode ?? null,
    permalink: m.permalink ?? null,
    caption: m.caption ?? null,
    mediaType: m.media_type ?? null,
    postedAt: Number.isNaN(ts) ? null : ts,
    ownerId: m.owner?.id ?? null,
    ownerUsername: m.username ?? null,
    isOwn,
  };
}

/** Tu cuenta (user_id + username), cacheada 24 h. Si Meta falla, se usa IG_USER_ID sin username. */
export async function getOwnIdentity(
  deps: AnalysisDeps,
  opts: { persist?: boolean } = {},
): Promise<OwnIdentity> {
  const now = deps.now?.() ?? Date.now();
  const cached = kvGet<OwnIdentity & { fetchedAt: number }>(deps.db, 'own_identity');
  if (cached && cached.userId === deps.igUserId && now - cached.fetchedAt < IDENTITY_TTL_MS) {
    return { userId: cached.userId, username: cached.username };
  }
  try {
    const me = await deps.read.getMe();
    if (me.user_id && me.user_id !== deps.igUserId) {
      deps.logger.warn(
        { ig_user_id_env: deps.igUserId, user_id_api: me.user_id },
        'IG_USER_ID no coincide con el user_id del token',
      );
    }
    const identity = { userId: deps.igUserId, username: me.username?.toLowerCase() ?? null };
    if (opts.persist !== false) kvSet(deps.db, 'own_identity', { ...identity, fetchedAt: now }, now);
    return identity;
  } catch (err) {
    deps.logger.warn({ err: (err as Error).message }, 'no se pudo leer /me; se usa solo IG_USER_ID');
    return { userId: deps.igUserId, username: cached?.username ?? null };
  }
}

/**
 * Datos del vídeo (caption cacheado por media). Con persist=false (dry-run) no escribe nada.
 * Si Meta responde 4xx al leerlo (p. ej. un vídeo ajeno en el que te mencionan), se marca como ajeno.
 */
export async function ensureMedia(
  deps: AnalysisDeps,
  mediaId: string,
  opts: { persist?: boolean; known?: IgMedia; own?: OwnIdentity } = {},
): Promise<MediaView> {
  const persist = opts.persist !== false;
  const now = deps.now?.() ?? Date.now();
  const row = getMedia(deps.db, mediaId);
  if (row && !opts.known && now - row.fetched_at < MEDIA_TTL_MS) return toView(row);

  const own = opts.own ?? (await getOwnIdentity(deps, { persist }));
  let upsert;
  try {
    const m = opts.known ?? (await deps.read.getMedia(mediaId));
    upsert = mediaUpsertFromApi(m, own);
  } catch (err) {
    if (err instanceof MetaApiError && err.status !== null && err.status >= 400 && err.status < 500) {
      deps.logger.warn({ media_id: mediaId, err: err.message }, 'vídeo no accesible: se trata como ajeno');
      upsert = { ...mediaUpsertFromApi({ id: mediaId }, own), isOwn: false };
    } else {
      throw err;
    }
  }
  if (persist) {
    upsertMedia(deps.db, upsert, now);
    return toView(getMedia(deps.db, mediaId)!);
  }
  return {
    mediaId,
    caption: upsert.caption ?? row?.caption ?? null,
    permalink: upsert.permalink ?? row?.permalink ?? null,
    shortcode: upsert.shortcode ?? row?.shortcode ?? null,
    isOwn: upsert.isOwn ?? (row ? row.is_own === 1 : null),
    question: row?.question ?? null,
    questionSource: row?.question_source ?? null,
  };
}

/**
 * Pregunta del vídeo. Si nunca se ha determinado, se intenta sacar del caption con el LLM.
 * Una pregunta fijada a mano (`pnpm question set`) nunca se sobrescribe.
 */
export async function ensureQuestion(
  deps: AnalysisDeps,
  media: MediaView,
  opts: { persist?: boolean } = {},
): Promise<MediaView> {
  if (media.questionSource) return media;
  const question = await detectQuestion(deps.llm, deps.prompts, media.caption);
  const source: QuestionSource = question ? 'caption' : 'none';
  if (opts.persist !== false) setQuestion(deps.db, media.mediaId, question, source, deps.now?.());
  deps.logger.info({ media_id: media.mediaId, question, source }, 'pregunta del vídeo detectada');
  return { ...media, question, questionSource: source };
}
