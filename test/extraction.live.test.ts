/**
 * Tests con Claude de verdad (no se ejecutan con `pnpm test`).
 *   ANTHROPIC_API_KEY=... pnpm test:live
 * Comprueban que los prompts de prompts/*.md producen lo esperado con los comentarios reales.
 */
import '../src/env.js';
import { describe, expect, it } from 'vitest';
import { createClaudeClient } from '../src/llm/claude.js';
import { extractFromComment } from '../src/llm/extract.js';
import { createPromptStore } from '../src/llm/prompts.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
const QUESTION = '¿qué oficio quieres?';

describe.skipIf(!apiKey)('extracción con Claude real (pregunta: "¿qué oficio quieres?")', () => {
  const llm = createClaudeClient({ apiKey: apiKey ?? '', model: process.env.CLAUDE_MODEL ?? 'claude-haiku-5-5' });
  const prompts = createPromptStore();
  const run = (username: string, text: string, existingLabels: string[] = []) =>
    extractFromComment(llm, prompts, { question: QUESTION, caption: null, existingLabels, username, text });

  it('"Yo quiero ser el que haga las herramientas" → herrero', async () => {
    const r = await run('cesar_h_marquez', 'Yo quiero ser el que haga las herramientas');
    expect(r.answers_question).toBe(true);
    expect(r.answer_label).toBe('herrero');
    expect(r.character_name).toBeNull();
  });

  it('"Quiero llamarme Dyland, y ser un jugador profesional de fútbol..." → futbolista + Dyland', async () => {
    const r = await run(
      'dyland_dd04',
      'Quiero llamarme Dyland, y ser un jugador profesional de fútbol en la región para entretener a todos',
    );
    expect(r.answers_question).toBe(true);
    expect(r.answer_label).toBe('futbolista');
    expect(r.character_name).toBe('Dyland');
  });

  it('"yooo y si me puedes vestir de spiderman..." → no responde a la pregunta', async () => {
    const r = await run('carlos_gamez419', 'yooo y si me puedes vestir de spiderman te lo agradecería');
    expect(r.answers_question).toBe(false);
  });

  it('"Yo quiero broooo🔥🔥🙌" → no responde a la pregunta', async () => {
    const r = await run('incognito_dvc', 'Yo quiero broooo🔥🔥🙌');
    expect(r.answers_question).toBe(false);
  });

  it('en un hilo, analiza al autor y no al comentario padre', async () => {
    const r = await extractFromComment(llm, prompts, {
      question: QUESTION,
      caption: null,
      existingLabels: ['herrero'],
      username: 'dyland_dd04',
      text: 'Quiero llamarme Dyland, y ser un jugador profesional de fútbol en la región para entretener a todos',
      parent: { username: 'cesar_h_marquez', text: 'Yo quiero ser el que haga las herramientas' },
    });
    expect(r.answer_label).toBe('futbolista');
    expect(r.character_name).toBe('Dyland');
  });

  it('reutiliza una etiqueta existente en vez de crear un sinónimo', async () => {
    const r = await run('ana', 'yo quiero forjar espadas y hachas', ['herrero', 'agricultor']);
    expect(r.answer_label).toBe('herrero');
  });
});
