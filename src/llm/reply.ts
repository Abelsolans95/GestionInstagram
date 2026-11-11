import { z } from 'zod';
import { hasLink } from '../pipeline/filters.js';
import { charLength } from '../pipeline/text.js';
import type { LlmClient } from './claude.js';
import type { PromptStore } from './prompts.js';

/** Respuesta del modelo: {"reply": string|null, "reason": string}. null = no responder. */
export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: ['string', 'null'] },
    reason: { type: 'string' },
    /** true si el comentario es una queja de que no sale en los vídeos. */
    complaint: { type: 'boolean' },
  },
  required: ['reply', 'reason', 'complaint'],
  additionalProperties: false,
} as const;

export const MAX_REPLY_CHARS = 200;

const ReplyZ = z.object({
  reply: z.string().nullable(),
  reason: z.string(),
  complaint: z.boolean().optional().default(false),
});

export interface ReplyInput {
  username: string;
  text: string;
  caption: string | null;
  question: string | null;
  parent: { username: string | null; text: string } | null;
  /**
   * Etiqueta de la extracción si el comentario responde a la pregunta del vídeo (p. ej. "cazador").
   * null/undefined = no responde o no se sabe.
   */
  answerLabel?: string | null;
  /** Tus últimas respuestas en este vídeo (más reciente primero), para no repetirse. */
  recentReplies?: string[];
}

/** Quita la mención inicial ("@pepe genial!!" → "genial!!") y acorta. */
function replyBody(text: string): string {
  // Recorte por caracteres completos: con .slice() un emoji puede quedar partido por la mitad.
  return [...text.replace(/^@[\w.]+\s*/, '').replace(/\s+/g, ' ').trim()].slice(0, 120).join('');
}

export function buildReplyUserMessage(i: ReplyInput): string {
  const lines = [
    `Caption del vídeo: ${i.caption ? `"""${i.caption}"""` : '(sin caption)'}`,
    `Pregunta del vídeo: ${i.question ? `"${i.question}"` : '(desconocida)'}`,
  ];
  if (i.answerLabel) {
    lines.push(
      `Este comentario responde a la pregunta del vídeo (respuesta: "${i.answerLabel}"): es participación, no una petición fuera de lo que pregunta el vídeo.`,
    );
  }
  if (i.parent) {
    lines.push(
      `Este comentario es una respuesta dentro de un hilo. Comentario padre (de @${i.parent.username ?? 'desconocido'}): """${i.parent.text}"""`,
    );
  }
  const recent = (i.recentReplies ?? []).map(replyBody).filter(Boolean);
  if (recent.length) {
    lines.push(
      'Mis últimas respuestas en este vídeo (la tuya tiene que ser distinta: otro arranque, otras palabras, otro emoji; no repitas preguntas):',
      ...recent.map((r) => `- ${r}`),
    );
  }
  lines.push(
    `Comentario de @${i.username}:`,
    `"""${i.text}"""`,
    '',
    `Tu respuesta debe empezar por @${i.username}. Devuelve solo el JSON.`,
  );
  return lines.join('\n');
}

export type ReplyValidation =
  | { ok: true; reply: string | null; reason: string; complaint: boolean }
  | { ok: false; error: 'json_invalid' | 'schema_invalid' | 'too_long' | 'contains_link'; raw: string; reason?: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Garantiza que el texto empieza por @usuario del autor:
 *  - si ya empieza por @usuario (sin distinguir mayúsculas), se deja;
 *  - si empieza por OTRA mención (p. ej. el "@usuario" o el @nombre de los ejemplos del prompt),
 *    se sustituye por la del autor;
 *  - si no empieza por ninguna mención, se añade delante.
 */
export function ensureMention(text: string, username: string): string {
  const t = text.trim();
  const own = new RegExp(`^@${escapeRe(username)}(?![\\w.])`, 'i');
  if (own.test(t)) return t.replace(own, `@${username}`);
  const other = /^@[\w.]+/;
  if (other.test(t)) return t.replace(other, `@${username}`);
  return `@${username} ${t}`;
}

/**
 * Normaliza un texto de respuesta (del modelo o editado a mano en la revisión).
 * Devuelve null si queda vacío (solo la mención); lanza si supera el límite.
 */
export function normalizeReplyText(text: string, username: string): { text: string | null; error?: 'too_long' | 'contains_link' } {
  const fixed = ensureMention(text.replace(/\s+/g, ' '), username);
  if (fixed.replace(new RegExp(`^@${escapeRe(username)}`, 'i'), '').trim() === '') return { text: null };
  if (charLength(fixed) > MAX_REPLY_CHARS) return { text: fixed, error: 'too_long' };
  if (hasLink(fixed)) return { text: fixed, error: 'contains_link' };
  return { text: fixed };
}

/**
 * Valida la salida del modelo:
 *  - JSON que no parsea o no cumple el esquema → descartar (ok: false) y loguear;
 *  - reply null → no responder;
 *  - si no empieza por @usuario → se añade;
 *  - más de 200 caracteres → descartar y loguear.
 */
export function validateReplyOutput(raw: string, username: string): ReplyValidation {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'json_invalid', raw };
  }
  const parsed = ReplyZ.safeParse(json);
  if (!parsed.success) return { ok: false, error: 'schema_invalid', raw };
  const { reply, reason, complaint } = parsed.data;
  if (reply === null || reply.trim() === '') return { ok: true, reply: null, reason, complaint };
  const n = normalizeReplyText(reply, username);
  if (n.error) return { ok: false, error: n.error, raw, reason };
  return { ok: true, reply: n.text, reason, complaint };
}

export async function generateReply(
  llm: LlmClient,
  prompts: PromptStore,
  input: ReplyInput,
): Promise<ReplyValidation> {
  const raw = await llm.completeJson({
    task: 'reply',
    // El prompt de estilo y, aparte, lo que ya existe en la historia (lo actualizas tú cada día).
    system: `${prompts.get('reply')}\n\n${prompts.get('historia')}`,
    user: buildReplyUserMessage(input),
    schema: REPLY_SCHEMA,
  });
  return validateReplyOutput(raw, input.username);
}
