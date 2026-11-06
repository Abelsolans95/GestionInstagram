import { describe, expect, it } from 'vitest';
import { buildReplyUserMessage, ensureMention, validateReplyOutput } from '../src/llm/reply.js';

const U = 'cesar_h_marquez';
const out = (reply: string | null, reason = 'ok') => JSON.stringify({ reply, reason });

describe('validación de la respuesta del modelo', () => {
  it('acepta una respuesta correcta', () => {
    expect(validateReplyOutput(out(`@${U} genial!! un herrero hacía falta 🔥`), U)).toEqual({
      ok: true,
      reply: `@${U} genial!! un herrero hacía falta 🔥`,
      reason: 'ok',
    });
  });

  it('si no empieza por @usuario, lo añade', () => {
    expect(validateReplyOutput(out('🔥🔥🔥'), U)).toMatchObject({ ok: true, reply: `@${U} 🔥🔥🔥` });
  });

  it('si empieza por otra mención (p. ej. la de un ejemplo del prompt), la sustituye por la del autor', () => {
    expect(validateReplyOutput(out('@usuario eso no te lo puedo decir 👀'), U)).toMatchObject({ reply: `@${U} eso no te lo puedo decir 👀` });
    expect(validateReplyOutput(out('@carlos_gamez419 jajaja lo vemos más adelante!!'), U)).toMatchObject({ reply: `@${U} jajaja lo vemos más adelante!!` });
  });

  it('respeta la mención correcta aunque cambien las mayúsculas', () => {
    expect(ensureMention('@Cesar_H_Marquez 🔥', U)).toBe(`@${U} 🔥`);
    expect(ensureMention(`@${U}🔥`, U)).toBe(`@${U}🔥`);
    expect(ensureMention(`@${U}.otro hola`, U)).toBe(`@${U} hola`);
  });

  it('reply null → no responder (con el motivo)', () => {
    expect(validateReplyOutput(out(null, 'insulto'), U)).toEqual({ ok: true, reply: null, reason: 'insulto' });
    expect(validateReplyOutput(out('   '), U)).toMatchObject({ ok: true, reply: null });
    expect(validateReplyOutput(out(`@${U}`), U)).toMatchObject({ ok: true, reply: null });
  });

  it('más de 200 caracteres → se descarta', () => {
    expect(validateReplyOutput(out(`@${U} ${'a'.repeat(190)}`), U)).toMatchObject({ ok: false, error: 'too_long' });
    // 200 justos (contando emojis como un carácter) sí vale
    const ok = `@${U} ${'🔥'.repeat(200 - U.length - 2)}`;
    expect(validateReplyOutput(out(ok), U)).toMatchObject({ ok: true });
  });

  it('JSON que no parsea o no cumple el esquema → se descarta', () => {
    expect(validateReplyOutput('@pepe hola', U)).toMatchObject({ ok: false, error: 'json_invalid' });
    expect(validateReplyOutput('{"reply": "hola"}', U)).toMatchObject({ ok: false, error: 'schema_invalid' });
    expect(validateReplyOutput('{"reply": 3, "reason": "x"}', U)).toMatchObject({ ok: false, error: 'schema_invalid' });
  });

  it('una respuesta con enlaces se descarta', () => {
    expect(validateReplyOutput(out('mira www.tienda.com'), U)).toMatchObject({ ok: false, error: 'contains_link' });
  });

  it('el mensaje al modelo lleva caption, pregunta, padre y el @usuario con el que empezar', () => {
    const m = buildReplyUserMessage({ username: U, text: 'hola', caption: 'Día 1', question: '¿qué oficio quieres?', parent: { username: 'ana', text: 'quién hace pan?' } });
    expect(m).toContain('Día 1');
    expect(m).toContain('"¿qué oficio quieres?"');
    expect(m).toContain('Comentario padre (de @ana): """quién hace pan?"""');
    expect(m).toContain(`Tu respuesta debe empezar por @${U}`);
  });
});
