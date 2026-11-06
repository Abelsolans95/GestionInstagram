import { describe, expect, it } from 'vitest';
import { setQuestion, upsertMedia } from '../src/db/analysis.js';
import { getComment, insertCommentIfNew } from '../src/db/comments.js';
import { openDb } from '../src/db/index.js';
import { LlmOutputError } from '../src/llm/claude.js';
import { buildExtractUserMessage, normalizeLabel, parseExtractOutput } from '../src/llm/extract.js';
import { parseQuestionOutput } from '../src/llm/question.js';
import { extractAndStore, type CommentForAnalysis } from '../src/pipeline/extraction.js';
import type { AnalysisDeps, MediaView } from '../src/pipeline/context.js';
import { fakeLlm, IG_USER_ID, silentLogger, testLists, testPrompts } from './helpers/fakes.js';

const QUESTION = '¿qué oficio quieres?';

// Los 4 comentarios reales del enunciado, con la salida que esperamos del modelo.
const REAL = [
  {
    user: 'cesar_h_marquez',
    text: 'Yo quiero ser el que haga las herramientas',
    model: { answers_question: true, answer: 'hacer las herramientas', answer_label: 'herrero', character_name: null },
    expected: { answers_question: true, answer_label: 'herrero', character_name: null },
  },
  {
    user: 'dyland_dd04',
    text: 'Quiero llamarme Dyland, y ser un jugador profesional de fútbol en la región para entretener a todos',
    model: { answers_question: true, answer: 'jugador profesional de fútbol', answer_label: 'futbolista', character_name: 'Dyland' },
    expected: { answers_question: true, answer_label: 'futbolista', character_name: 'Dyland' },
  },
  {
    user: 'carlos_gamez419',
    text: 'yooo y si me puedes vestir de spiderman te lo agradecería',
    model: { answers_question: false, answer: null, answer_label: null, character_name: null },
    expected: { answers_question: false, answer_label: null, character_name: null },
  },
  {
    user: 'incognito_dvc',
    text: 'Yo quiero broooo🔥🔥🙌',
    model: { answers_question: false, answer: null, answer_label: null, character_name: null },
    expected: { answers_question: false, answer_label: null, character_name: null },
  },
] as const;

describe('validación de la salida de extracción', () => {
  it.each(REAL)('$text', ({ model, expected }) => {
    expect(parseExtractOutput(JSON.stringify(model), [])).toMatchObject(expected);
  });

  it('normaliza la etiqueta (minúsculas, sin puntuación) y reutiliza las existentes', () => {
    expect(normalizeLabel('Herrero.', [])).toBe('herrero');
    expect(normalizeLabel('  Herréro ', ['herrero'])).toBe('herrero');
    expect(normalizeLabel('AGRICULTOR', ['agricultor', 'herrero'])).toBe('agricultor');
    expect(normalizeLabel('', [])).toBeNull();
    expect(normalizeLabel(null, ['herrero'])).toBeNull();
  });

  it('si no responde a la pregunta, borra answer/label pero conserva el nombre de personaje', () => {
    const r = parseExtractOutput(
      JSON.stringify({ answers_question: false, answer: 'algo', answer_label: 'x', character_name: ' "Thor" ' }),
      [],
    );
    expect(r).toEqual({ answers_question: false, answer: null, answer_label: null, character_name: 'Thor' });
  });

  it('rechaza JSON inválido o que no cumple el esquema', () => {
    expect(() => parseExtractOutput('no es json', [])).toThrow(LlmOutputError);
    expect(() => parseExtractOutput('{"answers_question": "si"}', [])).toThrow(LlmOutputError);
    expect(() => parseExtractOutput('{"answer": "x"}', [])).toThrow(LlmOutputError);
  });

  it('el mensaje al modelo incluye la pregunta, el caption, las etiquetas y el padre', () => {
    const msg = buildExtractUserMessage({
      question: QUESTION,
      caption: 'Día 3 de la humanidad',
      existingLabels: ['herrero', 'agricultor'],
      username: 'pepe',
      text: 'yo pescador',
      parent: { username: 'ana', text: '¿y tú qué serías?' },
    });
    expect(msg).toContain(`"${QUESTION}"`);
    expect(msg).toContain('Día 3 de la humanidad');
    expect(msg).toContain('herrero, agricultor');
    expect(msg).toContain('@ana');
    expect(msg).toContain('Comentario de @pepe:\n"""yo pescador"""');
  });

  it('pregunta desconocida y sin etiquetas se indican explícitamente', () => {
    const msg = buildExtractUserMessage({ question: null, caption: null, existingLabels: [], username: null, text: 'x' });
    expect(msg).toContain('(desconocida)');
    expect(msg).toContain('(ninguna todavía)');
  });
});

describe('detección de la pregunta', () => {
  it('parsea la salida', () => {
    expect(parseQuestionOutput('{"question":" ¿qué oficio quieres? "}')).toBe('¿qué oficio quieres?');
    expect(parseQuestionOutput('{"question":null}')).toBeNull();
    expect(() => parseQuestionOutput('{"q":1}')).toThrow(LlmOutputError);
  });
});

describe('extracción y guardado (tablas answers y participants)', () => {
  function setup() {
    const db = openDb(':memory:');
    upsertMedia(db, {
      mediaId: 'm1', shortcode: 'abc', permalink: 'https://instagram.com/reel/abc', caption: 'caption',
      mediaType: 'VIDEO', postedAt: 1, ownerId: IG_USER_ID, ownerUsername: null, isOwn: true,
    });
    setQuestion(db, 'm1', QUESTION, 'manual');
    const byText = new Map<string, unknown>(REAL.map((r) => [r.text, r.model]));
    const { llm, calls } = fakeLlm((req) => {
      const m = /"""([^"]*)"""$/.exec(req.user);
      return byText.get(m?.[1] ?? '') ?? { answers_question: false, answer: null, answer_label: null, character_name: null };
    });
    const deps = { db, llm, prompts: testPrompts, lists: testLists, igUserId: IG_USER_ID, logger: silentLogger } as unknown as AnalysisDeps;
    const media: MediaView = {
      mediaId: 'm1', caption: 'caption', permalink: null, shortcode: 'abc', isOwn: true, question: QUESTION, questionSource: 'manual',
    };
    let t = 1000;
    const add = async (id: string, user: string, text: string) => {
      const c: CommentForAnalysis = { commentId: id, mediaId: 'm1', username: user, igUserId: `ig-${user}`, text, commentedAt: (t += 1000) };
      insertCommentIfNew(db, { commentId: id, mediaId: 'm1', parentId: null, parentChecked: true, igUserId: c.igUserId, username: user, text, commentedAt: c.commentedAt, source: 'import', status: 'imported' });
      return extractAndStore(deps, c, media);
    };
    return { db, calls, add };
  }

  it('los 4 comentarios reales acaban en las tablas como se espera', async () => {
    const { db, add } = setup();
    for (const [i, r] of REAL.entries()) await add(`c${i}`, r.user, r.text);

    const answers = db.prepare('SELECT username, answer_label, question, is_latest FROM answers ORDER BY id').all();
    expect(answers).toEqual([
      { username: 'cesar_h_marquez', answer_label: 'herrero', question: QUESTION, is_latest: 1 },
      { username: 'dyland_dd04', answer_label: 'futbolista', question: QUESTION, is_latest: 1 },
    ]);
    const p = db.prepare('SELECT username, character_name, n_comments FROM participants ORDER BY username').all();
    expect(p).toEqual([
      { username: 'carlos_gamez419', character_name: null, n_comments: 1 },
      { username: 'cesar_h_marquez', character_name: null, n_comments: 1 },
      { username: 'dyland_dd04', character_name: 'Dyland', n_comments: 1 },
      { username: 'incognito_dvc', character_name: null, n_comments: 1 },
    ]);
    expect(getComment(db, 'c3')).toMatchObject({ extract_status: 'done', answers_question: 0 });
  });

  it('pasa al modelo las etiquetas ya usadas en el vídeo', async () => {
    const { add, calls } = setup();
    await add('a', 'cesar_h_marquez', REAL[0].text);
    await add('b', 'dyland_dd04', REAL[1].text);
    expect(calls[1]!.user).toContain('Etiquetas ya usadas en este vídeo: herrero');
  });

  it('si alguien responde varias veces, vale la última y queda marcado', async () => {
    const { db, add } = setup();
    await add('a', 'cesar_h_marquez', REAL[0].text); // herrero
    await add('b', 'cesar_h_marquez', REAL[1].text); // futbolista (+ Dyland)
    const rows = db.prepare('SELECT comment_id, answer_label, is_latest, n_answers FROM answers ORDER BY id').all();
    expect(rows).toEqual([
      { comment_id: 'a', answer_label: 'herrero', is_latest: 0, n_answers: 2 },
      { comment_id: 'b', answer_label: 'futbolista', is_latest: 1, n_answers: 2 },
    ]);
    expect(db.prepare("SELECT character_name, n_comments FROM participants WHERE username='cesar_h_marquez'").get())
      .toEqual({ character_name: 'Dyland', n_comments: 2 });
  });

  it('re-extraer el mismo comentario no duplica nada', async () => {
    const { db, add } = setup();
    await add('a', 'cesar_h_marquez', REAL[0].text);
    db.prepare("DELETE FROM comments WHERE comment_id = 'a'").run();
    await add('a', 'cesar_h_marquez', REAL[0].text);
    expect(db.prepare('SELECT COUNT(*) AS n FROM answers').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT n_comments FROM participants').get()).toEqual({ n_comments: 1 });
  });
});
