import { describe, expect, it } from 'vitest';
import { countByStatus, getComment } from '../src/db/comments.js';
import { openDb } from '../src/db/index.js';
import { assertImportAllowed, importComments } from '../src/importer/importComments.js';
import { createCommentQueue } from '../src/queue/commentQueue.js';
import { createCoreServices } from '../src/services.js';
import type { CommentEvent } from '../src/webhook/parse.js';
import { createReplyWorker, type CommentProcessor } from '../src/worker/replyWorker.js';
import { createFakeMeta } from './helpers/fakeMeta.js';
import { commentTextOf, fakeLlm, IG_USER_ID, OWN_USERNAME, silentLogger, testConfig, testLists, testPrompts } from './helpers/fakes.js';

const MEDIA = [
  { id: 'm1', caption: 'Día 1. ¿Qué oficio quieres? Comenta 👇', permalink: 'https://www.instagram.com/reel/AAA/', shortcode: 'AAA', timestamp: '2026-10-01T10:00:00+0000', media_type: 'VIDEO', owner: { id: IG_USER_ID } },
  { id: 'm2', caption: 'Día 2 🔥', permalink: 'https://www.instagram.com/reel/BBB/', shortcode: 'BBB', timestamp: '2026-10-02T10:00:00+0000', media_type: 'VIDEO', owner: { id: IG_USER_ID } },
];

const c = (id: string, username: string, text: string, ts = '2026-10-01T12:00:00+0000') => ({
  id, username, text, timestamp: ts, from: { id: `ig-${username}`, username },
});

const THREADS = {
  m1: [
    { comment: c('c1', 'cesar_h_marquez', 'Yo quiero ser el que haga las herramientas'), replies: [c('r1', OWN_USERNAME, 'genial!! 🔥'), c('r2', 'ana', 'yo también herrera')] },
    { comment: c('c2', 'dyland_dd04', 'Quiero llamarme Dyland, y ser un jugador profesional de fútbol en la región para entretener a todos') },
    { comment: c('c3', 'spammer', 'gana dinero desde casa') },
    { comment: c('c4', 'incognito_dvc', 'Yo quiero broooo🔥🔥🙌') },
  ],
  m2: [{ comment: c('c5', 'carlos_gamez419', 'yooo y si me puedes vestir de spiderman te lo agradecería') }],
};

const MODEL: Record<string, unknown> = {
  'Yo quiero ser el que haga las herramientas': { answers_question: true, answer: 'herramientas', answer_label: 'herrero', character_name: null },
  'yo también herrera': { answers_question: true, answer: 'herrera', answer_label: 'herrero', character_name: null },
  'Quiero llamarme Dyland, y ser un jugador profesional de fútbol en la región para entretener a todos': { answers_question: true, answer: 'futbolista', answer_label: 'futbolista', character_name: 'Dyland' },
};

function setup(opts: { pageSize?: number; expandedReplies?: number } = {}) {
  const meta = createFakeMeta({ igUserId: IG_USER_ID, username: OWN_USERNAME, media: MEDIA, threads: THREADS, ...opts });
  const { llm, calls: llmCalls } = fakeLlm((req) => {
    if (req.task === 'question') return { question: req.user.includes('oficio') ? '¿qué oficio quieres?' : null };
    return MODEL[commentTextOf(req)] ?? { answers_question: false, answer: null, answer_label: null, character_name: null };
  });
  const db = openDb(':memory:');
  const services = createCoreServices(testConfig(), silentLogger, {
    db, fetch: meta.fetch, llm, prompts: testPrompts, lists: testLists, sleep: async () => {},
  });
  return { db, meta, llmCalls, services };
}

describe('importación de comentarios existentes', () => {
  it('con la API de Meta mockeada: solo hace GET, ninguna petición POST', async () => {
    const { meta, services } = setup({ pageSize: 2, expandedReplies: 1 });
    await importComments(services.analysis, { dryRun: false });
    expect(meta.calls.length).toBeGreaterThan(0);
    expect(meta.posts()).toEqual([]);
    expect(new Set(meta.calls.map((x) => x.method))).toEqual(new Set(['GET']));
  });

  it('recorre todos los vídeos y comentarios, con paginación y respuestas en hilos', async () => {
    const { db, meta, services } = setup({ pageSize: 2, expandedReplies: 1 });
    const summary = await importComments(services.analysis, { dryRun: false });
    expect(summary).toMatchObject({ media: 2, comments: 7, own: 1, spam: 1, imported: 5, answers: 3, nonAnswers: 2, failed: 0 });
    // Paginación de /comments (pageSize 2 → 2 páginas en m1) y respuestas por /replies
    expect(meta.calls.filter((x) => x.path === '/m1/comments')).toHaveLength(2);
    expect(meta.calls.some((x) => x.path === '/c1/replies')).toBe(true);
    expect(getComment(db, 'r2')).toMatchObject({ parent_id: 'c1', thread_id: 'c1', answer_label: 'herrero' });
  });

  it('marca cada comentario como "imported" y guarda el análisis', async () => {
    const { db, services } = setup();
    await importComments(services.analysis, { dryRun: false });
    expect(countByStatus(db)).toEqual({ imported: 7 });
    expect(getComment(db, 'r1')).toMatchObject({ decision: 'own_comment', extract_status: 'skipped' });
    expect(getComment(db, 'c3')).toMatchObject({ decision: 'spam', extract_status: 'skipped' });
    expect(getComment(db, 'c2')).toMatchObject({ source: 'import', decision: 'imported', answer_label: 'futbolista', character_name: 'Dyland' });
    const report = db.prepare("SELECT answer_label, COUNT(*) AS n FROM answers WHERE media_id='m1' GROUP BY answer_label ORDER BY n DESC").all();
    expect(report).toEqual([{ answer_label: 'herrero', n: 2 }, { answer_label: 'futbolista', n: 1 }]);
    expect(db.prepare("SELECT question, question_source FROM media WHERE media_id='m1'").get()).toEqual({
      question: '¿qué oficio quieres?', question_source: 'caption',
    });
  });

  it('el worker ignora los importados aunque Meta reenvíe después su webhook', async () => {
    const { db, services } = setup();
    await importComments(services.analysis, { dryRun: false });
    const queue = createCommentQueue(db);
    const processed: string[] = [];
    const processor: CommentProcessor = async (row) => {
      processed.push(row.comment_id);
      return { status: 'skipped', decision: 'x' };
    };
    const worker = createReplyWorker({ db, queue, processComment: processor, logger: silentLogger });
    const ev: CommentEvent = { commentId: 'c1', mediaId: 'm1', text: 'x', fromId: 'ig-cesar_h_marquez', fromUsername: 'cesar_h_marquez', parentId: null, mediaProductType: null, accountId: null, sentAt: null };
    expect(queue.enqueueWebhookEvents([ev], new Date()).duplicates).toEqual(['c1']);
    await worker.drain();
    expect(processed).toEqual([]);
    expect(getComment(db, 'c1')!.status).toBe('imported');
  });

  it('volver a importar no repite nada (ya conocidos)', async () => {
    const { services, llmCalls } = setup();
    await importComments(services.analysis, { dryRun: false });
    const before = llmCalls.length;
    const again = await importComments(services.analysis, { dryRun: false });
    expect(again).toMatchObject({ alreadyKnown: 7, imported: 0 });
    expect(llmCalls.length).toBe(before);
  });

  it('--dry-run muestra lo que extraería sin guardar nada', async () => {
    const { db, services, meta } = setup();
    const lines: string[] = [];
    const summary = await importComments(services.analysis, { dryRun: true, print: (l) => lines.push(l) });
    expect(summary.imported).toBe(5);
    for (const t of ['comments', 'answers', 'participants', 'media', 'kv']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
    expect(lines.join('\n')).toContain('herrero');
    expect(lines.join('\n')).toContain('personaje: Dyland');
    expect(meta.posts()).toEqual([]);
  });

  it('se puede limitar a vídeos concretos', async () => {
    const { services } = setup();
    const s = await importComments(services.analysis, { dryRun: false, mediaIds: ['m2'] });
    expect(s).toMatchObject({ media: 1, comments: 1 });
  });

  it('solo se permite con REVIEW_MODE=true (o en dry-run)', () => {
    expect(() => assertImportAllowed({ reviewMode: false, dryRun: false })).toThrow(/REVIEW_MODE=true/);
    expect(() => assertImportAllowed({ reviewMode: false, dryRun: true })).not.toThrow();
    expect(() => assertImportAllowed({ reviewMode: true, dryRun: false })).not.toThrow();
  });

  it('si la extracción falla en un comentario, lo marca y sigue con el resto', async () => {
    const meta = createFakeMeta({ igUserId: IG_USER_ID, username: OWN_USERNAME, media: MEDIA, threads: THREADS });
    const { llm } = fakeLlm((req) => (req.task === 'question' ? { question: null } : commentTextOf(req).startsWith('Yo quiero ser') ? 'esto no es json' : { answers_question: false, answer: null, answer_label: null, character_name: null }));
    const db = openDb(':memory:');
    const services = createCoreServices(testConfig(), silentLogger, { db, fetch: meta.fetch, llm, prompts: testPrompts, lists: testLists });
    const s = await importComments(services.analysis, { dryRun: false });
    expect(s.failed).toBe(1);
    expect(getComment(db, 'c1')).toMatchObject({ status: 'imported', extract_status: 'failed' });
    expect(getComment(db, 'c4')).toMatchObject({ extract_status: 'done' });
  });

  it('un comentario que ya llegó por webhook no se toca, pero se completa su hilo si no se sabía', async () => {
    const { db, services } = setup();
    createCommentQueue(db).enqueueWebhookEvents(
      [{ commentId: 'r2', mediaId: 'm1', text: '', fromId: null, fromUsername: null, parentId: null, mediaProductType: 'REELS', accountId: IG_USER_ID, sentAt: null }],
      new Date(1),
    );
    db.prepare("UPDATE comments SET status = 'failed' WHERE comment_id = 'r2'").run();
    const s = await importComments(services.analysis, { dryRun: false });
    expect(s.alreadyKnown).toBe(1);
    expect(getComment(db, 'r2')).toMatchObject({ status: 'failed', parent_id: 'c1', thread_id: 'c1', parent_checked: 1, username: 'ana', text: 'yo también herrera' });
  });

  it('si Meta corta la paginación antes de tiempo, una segunda pasada trae el resto', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      comment: c(`t${i}`, `user${i}`, `comentario ${i}`),
      ...(i === 5 ? { replies: [c(`t${i}r`, 'ana', 'respuesta')] } : {}),
    }));
    const meta = createFakeMeta({
      igUserId: IG_USER_ID,
      username: OWN_USERNAME,
      media: [{ ...MEDIA[0]!, comments_count: 8 }],
      threads: { m1: many },
      pageSize: 2,
      nestedCap: 4,
    });
    const { llm } = fakeLlm((req) => (req.task === 'question' ? { question: null } : { answers_question: false, answer: null, answer_label: null, character_name: null }));
    const db = openDb(':memory:');
    const services = createCoreServices(testConfig(), silentLogger, { db, fetch: meta.fetch, llm, prompts: testPrompts, lists: testLists, sleep: async () => {} });
    const lines: string[] = [];
    const s = await importComments(services.analysis, { dryRun: false, print: (l) => lines.push(l) });
    expect(s).toMatchObject({ comments: 8, expected: 8, imported: 8 });
    expect(getComment(db, 't5r')).toMatchObject({ parent_id: 't5' });
    expect(lines.join('\n')).toContain('Instagram dice 8 comentarios y han llegado 4');
    expect(meta.posts()).toEqual([]);
  });
});
