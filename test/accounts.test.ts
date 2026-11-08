import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { assignLegacyRows, getMedia, upsertMedia } from '../src/db/analysis.js';
import { getComment, insertCommentIfNew, updateComment } from '../src/db/comments.js';
import { migrate, openDb } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { createAccountPromptStore, staticPromptStore } from '../src/llm/prompts.js';
import type { FetchLike } from '../src/meta/http.js';
import { createServiceProcessor } from '../src/pipeline/accountProcessor.js';
import { ensureMedia } from '../src/pipeline/context.js';
import { storeAnalysis } from '../src/pipeline/extraction.js';
import { complaintRepliesForUser } from '../src/pipeline/filters.js';
import { createCommentQueue } from '../src/queue/commentQueue.js';
import { buildParticipantsReport } from '../src/reports/queries.js';
import { createCoreServices } from '../src/services.js';
import type { CommentEvent } from '../src/webhook/parse.js';
import { createPublisher } from '../src/worker/publisher.js';
import { createReplyWorker } from '../src/worker/replyWorker.js';
import { createFakeMeta } from './helpers/fakeMeta.js';
import { fakeLlm, silentLogger, testConfig, testLists } from './helpers/fakes.js';

const A = '17841400000000001';
const B = '17841400000000002';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const HOUR = 3_600_000;

const base = {
  IG_APP_SECRET: 's',
  IG_ACCESS_TOKEN: 't',
  IG_USER_ID: A,
  WEBHOOK_VERIFY_TOKEN: 'v',
  ANTHROPIC_API_KEY: 'k',
  REPORT_TOKEN: '0123456789abcdef',
};

describe('configuración con varias cuentas', () => {
  it('una sola cuenta: como siempre', () => {
    const c = loadConfig(base);
    expect(c.meta.igUserId).toBe(A);
    expect(c.meta.accounts).toEqual([{ id: A, accessToken: 't' }]);
  });

  it('IG_USER_ID con varias, sin repetir; IG_ACCESS_TOKEN_<id> si existe', () => {
    const c = loadConfig({ ...base, IG_USER_ID: `${A}, ${B},${A}`, [`IG_ACCESS_TOKEN_${B}`]: 'tb' });
    expect(c.meta.accounts).toEqual([
      { id: A, accessToken: 't' },
      { id: B, accessToken: 'tb' },
    ]);
    expect(c.meta.igUserId).toBe(A);
  });

  it('rechaza IDs mal escritos y tokens pegados con saltos de línea', () => {
    expect(() => loadConfig({ ...base, IG_USER_ID: `${A};${B}` })).toThrow(/IG_USER_ID/);
    expect(() => loadConfig({ ...base, IG_USER_ID: `${A},${B}`, [`IG_ACCESS_TOKEN_${B}`]: 'EAA\nIG_USER_ID=1' })).toThrow(
      new RegExp(`IG_ACCESS_TOKEN_${B}`),
    );
  });
});

describe('datos de antes de tener varias cuentas', () => {
  it('se asignan una vez a la cuenta principal y los participantes se recalculan por cuenta', () => {
    const db = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 5)) db.exec(sql);
    db.pragma('user_version = 5');
    db.prepare(
      `INSERT INTO comments (comment_id, media_id, username, text, commented_at, source, status, extract_status, created_at, updated_at)
       VALUES ('c1', 'm1', 'pepe', 'yo pescador', 10, 'webhook', 'replied', 'done', 10, 10)`,
    ).run();
    db.prepare(`INSERT INTO media (media_id, is_own, fetched_at, updated_at) VALUES ('m1', 1, 10, 10)`).run();
    db.prepare(`INSERT INTO participants (username, first_seen, last_seen, n_comments) VALUES ('pepe', 10, 10, 1)`).run();
    migrate(db);

    expect(assignLegacyRows(db, A)).toBe(1);
    expect(getComment(db, 'c1')!.account_id).toBe(A);
    expect(getMedia(db, 'm1')!.account_id).toBe(A);
    expect(db.prepare('SELECT account_id, username, n_comments FROM participants').all()).toEqual([
      { account_id: A, username: 'pepe', n_comments: 1 },
    ]);
    // Solo una vez: lo que llegue después sin cuenta lo decide el worker.
    insertCommentIfNew(db, { commentId: 'c2', mediaId: 'm9', parentId: null, parentChecked: true, igUserId: null, username: 'ana', text: 'hola', commentedAt: 20, source: 'webhook', status: 'queued' });
    expect(assignLegacyRows(db, A)).toBe(0);
    expect(getComment(db, 'c2')!.account_id).toBeNull();
  });

  it('en una base de datos nueva no escribe nada', () => {
    const db = openDb(':memory:');
    expect(assignLegacyRows(db, A)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM kv').get()).toEqual({ n: 0 });
  });
});

describe('prompts por cuenta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-'));
  writeFileSync(join(dir, 'reply.md'), 'REPLY-PRINCIPAL');
  writeFileSync(join(dir, 'historia.md'), 'HISTORIA-PRINCIPAL');
  writeFileSync(join(dir, 'extract.md'), 'EXTRACT-PRINCIPAL');
  mkdirSync(join(dir, 'cuentas', 'repartidor'), { recursive: true });
  writeFileSync(join(dir, 'cuentas', 'repartidor', 'reply.md'), 'REPLY-REPARTIDOR');

  it('la principal usa prompts/ (o su carpeta, si la tiene)', () => {
    const p = createAccountPromptStore({ dir, primary: true, folders: () => ['humanidaddesdecero', A] });
    expect(p.get('reply')).toBe('REPLY-PRINCIPAL');
    expect(p.get('historia')).toBe('HISTORIA-PRINCIPAL');
    expect(p.has!('question')).toBe(false);
  });

  it('las demás solo usan su carpeta: reply obligatorio, historia opcional, sin extract no hay análisis', () => {
    const p = createAccountPromptStore({ dir, primary: false, folders: () => ['Repartidor', B] });
    expect(p.get('reply')).toBe('REPLY-REPARTIDOR');
    expect(p.get('historia')).toBe('');
    expect(p.has!('extract')).toBe(false);
    const sinCarpeta = createAccountPromptStore({ dir, primary: false, folders: () => ['otra', '17841400000000003'] });
    expect(() => sinCarpeta.get('reply')).toThrow(/prompts\/cuentas\/otra\/reply\.md/);
  });
});

/** Comentarios que el worker lee de Meta para confirmar el hilo (GET /{comment-id}). */
const COMMENTS = [
  ['deA', 'pepe', 'ig-pepe'],
  ['deB', 'lola', 'ig-lola'],
  ['x', 'lola', 'ig-lola'],
  ['y', 'pepe', 'ig-pepe'],
  ['mio', 'repartidor', B],
].map(([id, username, from]) => ({ id: id!, text: 'hola', username, timestamp: '2026-11-08T11:00:00+0000', from: { id: from!, username } }));

/** Dos cuentas con su propio token: cada petición va a la "Meta" de la cuenta cuyo token lleva. */
function setup(opts: { maxPerHour?: number } = {}) {
  const metaA = createFakeMeta({
    igUserId: A,
    username: 'humanidaddesdecero',
    media: [{ id: 'mA', caption: 'Día 1: ¿qué oficio quieres?', permalink: 'pA', shortcode: 'AAA', media_type: 'VIDEO', owner: { id: A } }],
    threads: {},
    comments: COMMENTS,
  });
  const metaB = createFakeMeta({
    igUserId: B,
    username: 'repartidor',
    media: [{ id: 'mB', caption: 'Hoy reparto en bici', permalink: 'pB', shortcode: 'BBB', media_type: 'VIDEO', owner: { id: B } }],
    threads: {},
    comments: COMMENTS,
  });
  const fetch: FetchLike = (url, init) =>
    new URL(url).searchParams.get('access_token') === 'tok-b' ? metaB.fetch(url, init) : metaA.fetch(url, init);
  const { llm, calls } = fakeLlm((req) => {
    if (req.task === 'question') return { question: '¿qué oficio quieres?' };
    if (req.task === 'extract') return { answers_question: true, answer: 'pescador', answer_label: 'pescador', character_name: null };
    return { reply: '@x genial!!', reason: 'hype', complaint: false };
  });
  const config = testConfig({ maxPerHour: opts.maxPerHour ?? 60 });
  config.meta.accessToken = 'tok-a';
  config.meta.accounts = [
    { id: A, accessToken: 'tok-a' },
    { id: B, accessToken: 'tok-b' },
  ];
  const db = openDb(':memory:');
  const s = createCoreServices(config, silentLogger, {
    db,
    fetch,
    llm,
    lists: testLists,
    sleep: async () => {},
    prompts: (id) =>
      id === A
        ? staticPromptStore({ reply: 'REPLY-A', extract: 'EXTRACT-A', question: 'QUESTION-A', historia: 'HISTORIA-A' })
        : staticPromptStore({ reply: 'REPLY-B', extract: null, question: null, historia: '' }),
  });
  const queue = createCommentQueue(db);
  const processComment = createServiceProcessor({
    db,
    accounts: s.accounts,
    llm,
    lists: testLists,
    logger: silentLogger,
    settings: config.replies,
    now: () => NOW,
  });
  const worker = createReplyWorker({ db, queue, processComment, logger: silentLogger });
  const send = async (events: Partial<CommentEvent>[]) => {
    queue.enqueueWebhookEvents(
      events.map((e, i) => ({
        commentId: `c${i}`,
        mediaId: 'mA',
        text: 'yo pescador',
        fromId: 'ig-pepe',
        fromUsername: 'pepe',
        parentId: null,
        mediaProductType: 'REELS',
        accountId: A,
        sentAt: NOW / 1000,
        ...e,
      })),
      new Date(NOW),
    );
    await worker.drain();
  };
  return { db, s, metaA, metaB, calls, send, config };
}

describe('varias cuentas en el mismo servicio', () => {
  it('cada comentario va a su cuenta y se responde con los prompts de esa cuenta', async () => {
    const { db, calls, send } = setup();
    await send([
      { commentId: 'deA', mediaId: 'mA', accountId: A },
      { commentId: 'deB', mediaId: 'mB', accountId: B, text: 'que hambre', fromUsername: 'lola', fromId: 'ig-lola' },
    ]);
    expect(getComment(db, 'deA')).toMatchObject({ account_id: A, status: 'pending_review', extract_status: 'done', answer_label: 'pescador' });
    // La cuenta B no tiene prompt de análisis: solo se responde.
    expect(getComment(db, 'deB')).toMatchObject({ account_id: B, status: 'pending_review', extract_status: 'skipped' });
    const replies = calls.filter((c) => c.task === 'reply');
    expect(replies.find((c) => c.user.includes('@pepe'))!.system).toBe('REPLY-A\n\nHISTORIA-A');
    expect(replies.find((c) => c.user.includes('@lola'))!.system).toBe('REPLY-B\n\n');
    expect(calls.filter((c) => c.task !== 'reply').every((c) => c.system.includes('-A'))).toBe(true);
    expect(getMedia(db, 'mB')).toMatchObject({ account_id: B, is_own: 1 });
  });

  it('si el webhook no trae la cuenta, se averigua por el dueño del vídeo (sin estropear la otra cuenta)', async () => {
    const { db, metaA, send } = setup();
    await send([{ commentId: 'x', mediaId: 'mB', accountId: null, fromUsername: 'lola', fromId: 'ig-lola' }]);
    expect(getComment(db, 'x')).toMatchObject({ account_id: B, status: 'pending_review' });
    // A no podía leer el vídeo de B: eso no le hace dejar de pedir el caption en sus vídeos.
    await send([{ commentId: 'y', mediaId: 'mA', accountId: A }]);
    const lastMediaRead = metaA.calls.filter((c) => c.path === '/mA').at(-1)!;
    expect(lastMediaRead.params.fields).toContain('caption');
  });

  it('los comentarios de tus otras cuentas no se responden', async () => {
    const { db, send } = setup();
    await send([{ commentId: 'mio', mediaId: 'mA', accountId: A, fromId: B, fromUsername: 'repartidor' }]);
    expect(getComment(db, 'mio')).toMatchObject({ status: 'skipped', decision: 'own_comment' });
  });

  it('un vídeo de otra de tus cuentas es ajeno para esta, sin preguntar a Meta y sin perder su dueño', async () => {
    const { db, s, metaB } = setup();
    upsertMedia(db, { mediaId: 'mA', accountId: A, shortcode: 'AAA', permalink: 'pA', caption: null, mediaType: 'VIDEO', postedAt: 1, ownerId: A, ownerUsername: null, isOwn: true });
    const b = s.accounts.get(B)!;
    expect((await ensureMedia(b.analysis, 'mA')).isOwn).toBe(false);
    expect(metaB.calls.filter((c) => c.path === '/mA')).toEqual([]);
    upsertMedia(db, { mediaId: 'mA', accountId: B, shortcode: 'AAA', permalink: 'pA', caption: null, mediaType: 'VIDEO', postedAt: 1, ownerId: A, ownerUsername: null, isOwn: false });
    expect(getMedia(db, 'mA')).toMatchObject({ account_id: A, is_own: 1 });
    expect(s.accounts.forMedia('mA').id).toBe(A);
  });

  it('cada cuenta publica con su token y tiene su propio tope por hora', async () => {
    const { db, s, metaA, metaB } = setup({ maxPerHour: 1 });
    const schedule = (id: string, account: string) => {
      insertCommentIfNew(db, { commentId: id, accountId: account, mediaId: 'm', parentId: null, parentChecked: true, igUserId: 'ig-u', username: 'pepe', text: 'hola', commentedAt: NOW - HOUR, source: 'webhook', status: 'queued' });
      updateComment(db, id, { status: 'scheduled', reply_text: '@pepe 🔥🔥', reply_target_id: `1700000000000000${id.length}`, publish_at: NOW - 1000 });
    };
    schedule('a1', A);
    schedule('a22', A);
    schedule('b333', B);
    const publisher = createPublisher({
      db,
      logger: silentLogger,
      maxPerHour: 1,
      accounts: s.accounts.all.map((a) => ({ id: a.id, graph: a.graph, read: a.read, ownUsername: () => s.accounts.username(a.id) })),
      now: () => NOW,
    });
    expect(await publisher.tick()).toBe(2);
    expect(metaA.posts().map((p) => p.params.access_token)).toEqual(['tok-a']);
    expect(metaB.posts().map((p) => p.params.access_token)).toEqual(['tok-b']);
    expect(getComment(db, 'b333')!.status).toBe('replied');
    // A ya ha llegado a su tope (1/h); B también. El segundo de A espera.
    expect(await publisher.tick()).toBe(0);
    expect(getComment(db, 'a22')!.status).toBe('scheduled');
    expect(publisher.repliesLastHour()).toBe(2);
    expect(publisher.repliesLastHour(A)).toBe(1);
  });

  it('la queja de "no salgo" se cuenta por cuenta', () => {
    const { db } = setup();
    insertCommentIfNew(db, { commentId: 'q', accountId: A, mediaId: 'mA', parentId: null, parentChecked: true, igUserId: 'ig-pepe', username: 'pepe', text: 'nunca salgo', commentedAt: 1, source: 'webhook', status: 'queued' });
    updateComment(db, 'q', { status: 'replied', reply_kind: 'complaint' });
    expect(complaintRepliesForUser(db, 'pepe', 'otro', A)).toBe(1);
    expect(complaintRepliesForUser(db, 'pepe', 'otro', B)).toBe(0);
  });

  it('los participantes son de cada cuenta', () => {
    const { db } = setup();
    for (const [id, account, mediaId] of [['p1', A, 'mA'], ['p2', B, 'mB']] as const) {
      upsertMedia(db, { mediaId, accountId: account, shortcode: mediaId, permalink: null, caption: null, mediaType: 'VIDEO', postedAt: 1, ownerId: account, ownerUsername: null, isOwn: true });
      insertCommentIfNew(db, { commentId: id, accountId: account, mediaId, parentId: null, parentChecked: true, igUserId: 'ig-pepe', username: 'pepe', text: 'yo', commentedAt: 1, source: 'import', status: 'imported' });
      storeAnalysis(
        db,
        { commentId: id, mediaId, username: 'pepe', igUserId: 'ig-pepe', text: 'yo', commentedAt: 1 },
        { mediaId, caption: null, permalink: null, shortcode: null, isOwn: true, question: '¿qué?', questionSource: 'manual' },
        { answers_question: true, answer: id, answer_label: id, character_name: account === A ? 'Pepín' : null },
      );
    }
    const a = buildParticipantsReport(db, A);
    expect(a.participants).toMatchObject([{ username: 'pepe', characterName: 'Pepín', nComments: 1 }]);
    expect(Object.keys(a.participants[0]!.answers)).toEqual(['mA']);
    const b = buildParticipantsReport(db, B);
    expect(b.participants).toMatchObject([{ username: 'pepe', characterName: null, nComments: 1 }]);
    expect(Object.keys(b.participants[0]!.answers)).toEqual(['mB']);
  });

  it('informes: vídeos separados por cuenta y participantes con ?cuenta=', async () => {
    const { db } = setup();
    upsertMedia(db, { mediaId: 'mA', accountId: A, shortcode: 'AAA', permalink: null, caption: null, mediaType: 'VIDEO', postedAt: 1, ownerId: A, ownerUsername: null, isOwn: true });
    upsertMedia(db, { mediaId: 'mB', accountId: B, shortcode: 'BBB', permalink: null, caption: null, mediaType: 'VIDEO', postedAt: 2, ownerId: B, ownerUsername: null, isOwn: true });
    const token = 'report-token-0123456789';
    const app = await buildApp({
      logger: silentLogger,
      webhook: { appSecret: 's', verifyToken: 'v', enqueue: () => {} },
      reports: {
        db,
        reportToken: token,
        accounts: () => [
          { id: A, label: '@humanidaddesdecero' },
          { id: B, label: '@repartidor' },
        ],
      },
    });
    const index = (await app.inject({ method: 'GET', url: `/report?token=${token}` })).body;
    expect(index.indexOf('@humanidaddesdecero')).toBeLessThan(index.indexOf('/report/mA'));
    expect(index.indexOf('@repartidor')).toBeLessThan(index.indexOf('/report/mB'));
    expect(index.indexOf('/report/mA')).toBeLessThan(index.indexOf('@repartidor'));
    const people = (await app.inject({ method: 'GET', url: `/participants?cuenta=repartidor&token=${token}` })).body;
    expect(people).toContain('Participantes (0) · @repartidor');
    await app.close();
  });
});
