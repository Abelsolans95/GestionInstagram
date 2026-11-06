import { z } from 'zod';
import { fold } from '../pipeline/text.js';
import { LlmOutputError, type LlmClient } from './claude.js';
import type { PromptStore } from './prompts.js';

/** Salida de la extracción: lo que el seguidor responde a la pregunta del vídeo. */
export interface ExtractResult {
  answers_question: boolean;
  answer: string | null;
  answer_label: string | null;
  character_name: string | null;
}

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    answers_question: { type: 'boolean' },
    answer: { type: ['string', 'null'] },
    answer_label: { type: ['string', 'null'] },
    character_name: { type: ['string', 'null'] },
  },
  required: ['answers_question', 'answer', 'answer_label', 'character_name'],
  additionalProperties: false,
} as const;

const ExtractZ = z.object({
  answers_question: z.boolean(),
  answer: z.string().nullable(),
  answer_label: z.string().nullable(),
  character_name: z.string().nullable(),
});

export interface ExtractInput {
  question: string | null;
  caption: string | null;
  existingLabels: string[];
  username: string | null;
  text: string;
  parent?: { username: string | null; text: string } | null;
}

export function buildExtractUserMessage(i: ExtractInput): string {
  const lines = [
    `Pregunta del vídeo: ${i.question ? `"${i.question}"` : '(desconocida)'}`,
    `Caption del vídeo: ${i.caption ? `"""${i.caption}"""` : '(sin caption)'}`,
    `Etiquetas ya usadas en este vídeo: ${i.existingLabels.length ? i.existingLabels.join(', ') : '(ninguna todavía)'}`,
  ];
  if (i.parent) {
    lines.push(
      `Este comentario es una respuesta dentro de un hilo. Comentario al que responde (de @${i.parent.username ?? 'desconocido'}): """${i.parent.text}"""`,
    );
  }
  lines.push(`Comentario de @${i.username ?? 'desconocido'}:`, `"""${i.text}"""`);
  return lines.join('\n');
}

function cleanString(s: string | null, max: number): string | null {
  if (s === null) return null;
  const t = s.trim().replace(/^["'«“]+|["'»”]+$/g, '').trim();
  if (!t) return null;
  return [...t].slice(0, max).join('');
}

/** Normaliza la etiqueta y, si coincide (sin tildes/mayúsculas) con una ya usada, usa esa. */
export function normalizeLabel(label: string | null, existing: string[]): string | null {
  if (label === null) return null;
  const t = label
    .trim()
    .toLowerCase()
    .replace(/[.,;:!¡?¿"'«»“”]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  const match = existing.find((e) => fold(e) === fold(t));
  return match ?? [...t].slice(0, 40).join('');
}

/** Parsea y valida la salida del modelo. Lanza LlmOutputError si no es JSON válido o no cumple. */
export function parseExtractOutput(raw: string, existingLabels: string[]): ExtractResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmOutputError('la extracción no es JSON válido', raw);
  }
  const parsed = ExtractZ.safeParse(json);
  if (!parsed.success) throw new LlmOutputError('la extracción no cumple el esquema', raw);
  const o = parsed.data;
  const character_name = cleanString(o.character_name, 40);
  if (!o.answers_question) {
    return { answers_question: false, answer: null, answer_label: null, character_name };
  }
  const answer = cleanString(o.answer, 200);
  const answer_label = normalizeLabel(o.answer_label, existingLabels);
  return { answers_question: true, answer: answer ?? answer_label, answer_label, character_name };
}

export async function extractFromComment(
  llm: LlmClient,
  prompts: PromptStore,
  input: ExtractInput,
): Promise<ExtractResult> {
  const raw = await llm.completeJson({
    task: 'extract',
    system: prompts.get('extract'),
    user: buildExtractUserMessage(input),
    schema: EXTRACT_SCHEMA,
  });
  return parseExtractOutput(raw, input.existingLabels);
}
