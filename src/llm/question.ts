import { z } from 'zod';
import { LlmOutputError, type LlmClient } from './claude.js';
import type { PromptStore } from './prompts.js';

export const QUESTION_SCHEMA = {
  type: 'object',
  properties: { question: { type: ['string', 'null'] } },
  required: ['question'],
  additionalProperties: false,
} as const;

const QuestionZ = z.object({ question: z.string().nullable() });

export function parseQuestionOutput(raw: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmOutputError('la detección de pregunta no es JSON válido', raw);
  }
  const parsed = QuestionZ.safeParse(json);
  if (!parsed.success) throw new LlmOutputError('la detección de pregunta no cumple el esquema', raw);
  const q = parsed.data.question?.trim();
  return q ? [...q].slice(0, 200).join('') : null;
}

/** Intenta sacar del caption la pregunta que el vídeo hace a los seguidores. */
export async function detectQuestion(
  llm: LlmClient,
  prompts: PromptStore,
  caption: string | null,
): Promise<string | null> {
  if (!caption || !caption.trim()) return null;
  const raw = await llm.completeJson({
    task: 'question',
    system: prompts.get('question'),
    user: `Caption del vídeo:\n"""${caption}"""`,
    schema: QUESTION_SCHEMA,
    maxTokens: 2048,
  });
  return parseQuestionOutput(raw);
}
