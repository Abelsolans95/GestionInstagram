import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setQuestion, upsertMedia } from '../src/db/analysis.js';
import { insertCommentIfNew, updateComment } from '../src/db/comments.js';
import { openDb, type DB } from '../src/db/index.js';
import { storeAnalysis } from '../src/pipeline/extraction.js';
import type { MediaView } from '../src/pipeline/context.js';
import { csvCell } from '../src/reports/csv.js';
import { IG_USER_ID, silentLogger } from './helpers/fakes.js';

const TOKEN = 'report-token-0123456789';
const QUESTION = '¿qué oficio quieres?';

const media: MediaView = { mediaId: 'm1', caption: null, permalink: 'https://www.instagram.com/reel/AAA/', shortcode: 'AAA', isOwn: true, question: QUESTION, questionSource: 'manual' };

let db: DB;
let app: FastifyInstance;
let t = 1_000_000;

function add(id: string, username: string, text: string, r: { label?: string; answer?: string; character?: string } = {}, mediaId = 'm1') {
  t += 1000;
  insertCommentIfNew(db, { commentId: id, mediaId, parentId: null, parentChecked: true, igUserId: `ig-${username}`, username, text, commentedAt: t, source: 'import', status: 'imported' });
  storeAnalysis(
    db,
    { commentId: id, mediaId, username, igUserId: `ig-${username}`, text, commentedAt: t },
    { ...media, mediaId },
    { answers_question: !!r.label, answer: r.answer ?? r.label ?? null, answer_label: r.label ?? null, character_name: r.character ?? null },
  );
}

const strip = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/, '').replace(/<br>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

beforeAll(async () => {
  db = openDb(':memory:');
  for (const [id, q] of [['m1', QUESTION], ['m2', '¿qué construimos primero?']] as const) {
    upsertMedia(db, { mediaId: id, shortcode: id, permalink: `https://www.instagram.com/reel/${id}/`, caption: null, mediaType: 'VIDEO', postedAt: id === 'm1' ? 1 : 2, ownerId: IG_USER_ID, ownerUsername: null, isOwn: true });
    setQuestion(db, id, q, 'manual');
  }
  add('1', 'a', 'el que haga las herramientas', { label: 'herrero' });
  add('2', 'b', 'yo pescador', { label: 'pescador' });
  add('3', 'b', 'mejor forjar cosas', { label: 'herrero' }); // b cambia de opinión: cuenta la última
  add('4', 'c', 'herrera!!', { label: 'herrero' });
  add('5', 'dyland_dd04', 'Quiero llamarme Dyland, y ser futbolista', { label: 'futbolista', character: 'Dyland' });
  add('6', 'incognito_dvc', 'Yo quiero broooo🔥🔥🙌');
  add('7', 'x<script>', '<b>hola</b>');
  add('8', 'a', 'una cabaña', { label: 'cabaña' }, 'm2');
  app = await buildApp({
    logger: silentLogger,
    webhook: { appSecret: 's', verifyToken: 'v', enqueue: () => {} },
    reports: { db, reportToken: TOKEN },
  });
});

afterAll(async () => {
  await app.close();
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

describe('protección con REPORT_TOKEN', () => {
  it.each(['/report', '/report/m1', '/participants', '/report/m1?format=csv'])('%s sin token → 401', async (url) => {
    expect((await get(url)).statusCode).toBe(401);
    expect((await get(`${url}${url.includes('?') ? '&' : '?'}token=malo`)).statusCode).toBe(401);
  });

  it('acepta ?token= y Authorization: Bearer', async () => {
    expect((await get(`/report/m1?token=${TOKEN}`)).statusCode).toBe(200);
    expect((await get('/report/m1', { authorization: `Bearer ${TOKEN}` })).statusCode).toBe(200);
  });

  it('no se cachea ni filtra el token por Referer', async () => {
    const res = await get(`/report/m1?token=${TOKEN}`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('GET /report/:mediaId', () => {
  it('muestra la pregunta y las respuestas agrupadas por etiqueta, de más a menos personas', async () => {
    const res = await get(`/report/m1?token=${TOKEN}`);
    expect(res.headers['content-type']).toContain('text/html');
    const text = strip(res.body);
    expect(text).toContain(QUESTION);
    expect(text).toContain('herrero (3): @a, @b*, @c');
    expect(text).toContain('futbolista (1): @dyland_dd04');
    expect(text.indexOf('herrero (3)')).toBeLessThan(text.indexOf('futbolista (1)'));
    // b respondió "pescador" y luego "herrero": solo cuenta la última
    expect(text).not.toContain('pescador (1)');
    expect(text).toContain('respondió varias veces');
  });

  it('al final, los comentarios que no responden a la pregunta', async () => {
    const text = strip((await get(`/report/m1?token=${TOKEN}`)).body);
    const idx = text.indexOf('No responden a la pregunta (2)');
    expect(idx).toBeGreaterThan(text.indexOf('herrero (3)'));
    expect(text.slice(idx)).toContain('@incognito_dvc: Yo quiero broooo🔥🔥🙌');
  });

  it('escapa el HTML de los comentarios', async () => {
    const res = await get(`/report/m1?token=${TOKEN}`);
    expect(res.body).not.toContain('<script>');
    expect(res.body).toContain('&lt;b&gt;hola&lt;/b&gt;');
  });

  it('404 si el vídeo no existe', async () => {
    expect((await get(`/report/nada?token=${TOKEN}`)).statusCode).toBe(404);
  });

  it('?format=csv exporta una fila por persona y al final los que no responden', async () => {
    const res = await get(`/report/m1?format=csv&token=${TOKEN}`);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('informe-m1.csv');
    const lines = res.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('media_id,pregunta,etiqueta,personas_en_etiqueta,usuario,respuesta,comentario,fecha,varias_respuestas,comment_id');
    expect(lines.slice(1, 4).every((l) => l.includes(',herrero,3,'))).toBe(true);
    expect(lines.find((l) => l.includes(',b,'))).toContain(',2,3'); // varias respuestas (2), comment 3
    expect(lines.at(-1)).toContain('(no responde a la pregunta)');
  });
});

describe('GET /report/:mediaId?format=md', () => {
  it('descarga lo mismo que la página en Markdown', async () => {
    const res = await get(`/report/m1?format=md&token=${TOKEN}`);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('informe-m1.md');
    const md = res.body;
    expect(md).toMatch(/^# ¿qué oficio quieres\?/);
    expect(md).toContain('- **herrero (3):** @a, @b*, @c');
    expect(md).toContain('- **futbolista (1):** @dyland_dd04');
    expect(md).toContain('(*) respondió varias veces');
    expect(md).not.toContain('\\');
    expect(md.indexOf('herrero (3)')).toBeLessThan(md.indexOf('futbolista (1)'));
    expect(md).toContain('## No responden a la pregunta (2)');
    expect(md.indexOf('## No responden')).toBeGreaterThan(md.indexOf('## Detalle'));
    expect(md).toContain('“el que haga las herramientas”');
  });

  it('la página enlaza el MD', async () => {
    expect((await get(`/report/m1?token=${TOKEN}`)).body).toContain(`format=md&token=${TOKEN}`);
  });
});

describe('GET /report/:mediaId?format=conversaciones', () => {
  it('cada hilo con tus respuestas marcadas (y las automáticas aparte)', async () => {
    upsertMedia(db, { mediaId: 'm3', shortcode: 'm3', permalink: null, caption: null, mediaType: 'VIDEO', postedAt: 3, ownerId: IG_USER_ID, ownerUsername: null, isOwn: true });
    setQuestion(db, 'm3', '¿qué sabes hacer?', 'manual');
    const c = (id: string, username: string, text: string, at: number, parentId: string | null = null) =>
      insertCommentIfNew(db, { commentId: id, mediaId: 'm3', parentId, parentChecked: true, igUserId: null, username, text, commentedAt: at, source: 'import', status: 'imported' });
    c('t1', 'ana', 'Puedo cazar?', 10);
    c('t1r', 'humanidaddesdecero', '@ana un cazador hacía falta!! 🔥', 20, 't1');
    updateComment(db, 't1r', { decision: 'own_comment' });
    c('t2', 'luis', 'yo pesco', 15);
    c('t2r', 'humanidaddesdecero', '@luis 🔥', 30, 't2');
    updateComment(db, 't2r', { decision: 'own_comment' });
    updateComment(db, 't2', { reply_comment_id: 't2r' });
    c('t3', 'eva', 'qué guapo', 25);

    const res = await get(`/report/m3?format=conversaciones&token=${TOKEN}`);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('conversaciones-m3.md');
    expect(res.body).toContain('# Conversaciones · ¿qué sabes hacer?');
    expect(res.body).toContain('3 hilos · respondiste en 2');
    expect(res.body).toContain('- @ana: Puedo cazar?\n  - **tú:** @ana un cazador hacía falta!! 🔥');
    expect(res.body).toContain('- @luis: yo pesco\n  - **tú (automática):** @luis 🔥');
    expect(res.body).toContain('- @eva: qué guapo\n  - (sin respuesta)');
  });

  it('la página enlaza la descarga y un vídeo desconocido da 404', async () => {
    expect((await get(`/report/m1?token=${TOKEN}`)).body).toContain(`format=conversaciones&token=${TOKEN}`);
    expect((await get(`/report/nope?format=conversaciones&token=${TOKEN}`)).statusCode).toBe(404);
  });
});

describe('GET /report (índice)', () => {
  it('lista los vídeos con su pregunta y enlaces que conservan el token', async () => {
    const res = await get(`/report?token=${TOKEN}`);
    expect(strip(res.body)).toContain('¿qué construimos primero?');
    expect(res.body).toContain(`/report/m1?token=${TOKEN}`);
  });
});

describe('GET /participants', () => {
  it('ficha por seguidor con su personaje y su respuesta en cada vídeo', async () => {
    const text = strip((await get(`/participants?token=${TOKEN}`)).body);
    expect(text).toContain('@dyland_dd04 · personaje: Dyland');
    expect(text).toMatch(/@a .*2 comentarios.*¿qué oficio quieres\? herrero.*¿qué construimos primero\? cabaña/);
    expect(text).toMatch(/@b .*herrero.*\*/);
  });

  it('?format=csv con una columna por vídeo', async () => {
    const res = await get(`/participants?format=csv&token=${TOKEN}`);
    const lines = res.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('usuario,personaje,n_comentarios,primera_vez,ultima_vez,¿qué oficio quieres?,¿qué construimos primero?');
    expect(lines.find((l) => l.startsWith('dyland_dd04,'))).toMatch(/^dyland_dd04,Dyland,1,.*,futbolista,$/);
    expect(lines.find((l) => l.startsWith('a,'))).toMatch(/^a,,2,.*,herrero,cabaña$/);
  });
});

describe('CSV', () => {
  it('escapa comillas/comas y neutraliza fórmulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('di "hola"')).toBe('"di ""hola"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@amigo mira')).toBe("'@amigo mira");
    expect(csvCell(null)).toBe('');
  });
});
