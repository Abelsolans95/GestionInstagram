import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DB } from '../db/index.js';
import { isEmojiOnly, normalizeForMatch } from './text.js';

/**
 * Filtros de respuesta. Solo deciden si se RESPONDE; la extracción se hace igualmente,
 * salvo para comentarios propios y spam.
 *
 *  - propio (IG_USER_ID / tu username)  → ni extracción ni respuesta
 *  - spam                               → ni extracción ni respuesta
 *  - enlaces                            → extracción sí, respuesta no
 *  - términos bloqueados (blocked.txt)  → extracción sí, respuesta no
 *  - 2 respuestas a ese usuario en ese hilo en 24 h → extracción sí, respuesta no
 *  - status "imported"                  → nunca se responde
 * Los comentarios de solo emojis SÍ se responden.
 */

// ---------- listas configurables (config/*.txt) ----------

export interface TermList {
  /** Términos normalizados. Un término acabado en * es un prefijo ("gilipoll*"). */
  terms: string[];
}

/** Lee una lista: un término o frase por línea; # para comentarios. */
export function parseTermList(content: string): TermList {
  const terms = content
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map((t) => {
      const prefix = t.endsWith('*');
      const n = normalizeForMatch(prefix ? t.slice(0, -1) : t);
      return n ? (prefix ? `${n}*` : n) : '';
    })
    .filter(Boolean);
  return { terms: [...new Set(terms)] };
}

export interface FilterLists {
  blocked(): TermList;
  spam(): TermList;
}

/** Listas en config/, recargadas si cambia el fichero. Si no existe, lista vacía. */
export function createFilterLists(dir = resolve(process.cwd(), 'config')): FilterLists {
  const cache = new Map<string, { mtimeMs: number; list: TermList }>();
  const load = (file: string): TermList => {
    const path = join(dir, file);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return { terms: [] };
    }
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.list;
    const list = parseTermList(readFileSync(path, 'utf8'));
    cache.set(path, { mtimeMs, list });
    return list;
  };
  return { blocked: () => load('blocked.txt'), spam: () => load('spam.txt') };
}

export function staticFilterLists(blocked: string[] = [], spam: string[] = []): FilterLists {
  const b = parseTermList(blocked.join('\n'));
  const s = parseTermList(spam.join('\n'));
  return { blocked: () => b, spam: () => s };
}

/** Devuelve el primer término de la lista que aparece en el texto (por palabras completas). */
export function findTerm(text: string, list: TermList): string | null {
  const hay = ` ${normalizeForMatch(text)} `;
  for (const term of list.terms) {
    if (term.endsWith('*')) {
      const stem = term.slice(0, -1);
      if (hay.includes(` ${stem}`)) return term;
    } else if (hay.includes(` ${term} `)) {
      return term;
    }
  }
  return null;
}

// ---------- detectores ----------

const URL_RE =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|es|io|me|ly|link|links|shop|store|xyz|info|co|app|site|online|top|click|live|tv|gg|bio|page|club|vip)\b(?:\/\S*)?/i;
const SHORTLINK_RE = /\b(?:bit\.ly|t\.me|wa\.me|linktr\.ee|tinyurl\.com|goo\.gl)\b/i;

export function hasLink(text: string): boolean {
  return URL_RE.test(text) || SHORTLINK_RE.test(text);
}

export function countMentions(text: string): number {
  return (text.match(/(^|[^\w@])@[\w.]{2,30}/g) ?? []).length;
}

export interface SpamCheck {
  isSpam: boolean;
  reason: string | null;
}

export interface SpamContext {
  lists: FilterLists;
  /** Veces que este usuario ha publicado este mismo texto en las últimas 24 h (sin contar este). */
  sameTextCount?: number;
}

/** Spam: frases típicas (config/spam.txt), muchas menciones o el mismo texto repetido. */
export function checkSpam(text: string, ctx: SpamContext): SpamCheck {
  if (isEmojiOnly(text)) return { isSpam: false, reason: null };
  const phrase = findTerm(text, ctx.lists.spam());
  if (phrase) return { isSpam: true, reason: `frase de spam: ${phrase}` };
  if (countMentions(text) >= 5) return { isSpam: true, reason: 'demasiadas menciones' };
  if ((ctx.sameTextCount ?? 0) >= 2 && normalizeForMatch(text).length >= 15) {
    return { isSpam: true, reason: 'mismo texto repetido' };
  }
  return { isSpam: false, reason: null };
}

export function findBlockedTerm(text: string, lists: FilterLists): string | null {
  return findTerm(text, lists.blocked());
}

export interface OwnIdentity {
  userId: string;
  username: string | null;
}

export function isOwnComment(
  c: { igUserId: string | null; username: string | null },
  own: OwnIdentity,
): boolean {
  if (c.igUserId && c.igUserId === own.userId) return true;
  return !!(c.username && own.username && c.username.toLowerCase() === own.username.toLowerCase());
}

// ---------- consultas a la BD ----------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Respuestas automáticas (pendientes, programadas o publicadas) a ese usuario en ese hilo en 24 h. */
export function autoRepliesInThread(
  db: DB,
  threadId: string,
  username: string,
  excludeCommentId: string,
  now = Date.now(),
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM comments
       WHERE thread_id = ? AND lower(username) = lower(?) AND comment_id != ?
         AND status IN ('pending_review', 'scheduled', 'publishing', 'replied')
         AND COALESCE(replied_at, updated_at) >= ?`,
    )
    .get(threadId, username, excludeCommentId, now - DAY_MS) as { n: number };
  return row.n;
}

export function sameTextCount(
  db: DB,
  username: string,
  text: string,
  excludeCommentId: string,
  now = Date.now(),
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM comments
       WHERE lower(username) = lower(?) AND text = ? AND comment_id != ? AND created_at >= ?`,
    )
    .get(username, text, excludeCommentId, now - DAY_MS) as { n: number };
  return row.n;
}

/**
 * Respuestas a quejas de "no salgo" que ya tiene esta persona (pendientes, programadas o
 * publicadas; las rechazadas en revisión no cuentan), en cualquier vídeo.
 */
export function complaintRepliesForUser(db: DB, username: string, excludeCommentId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM comments
       WHERE lower(username) = lower(?) AND reply_kind = 'complaint' AND comment_id != ?
         AND status IN ('pending_review', 'scheduled', 'publishing', 'replied')`,
    )
    .get(username, excludeCommentId) as { n: number };
  return row.n;
}
