import type { FastifyPluginAsync } from 'fastify';
import type { DB } from '../db/index.js';
import { requestToken, requireToken } from '../reports/auth.js';
import { esc, nav, page } from '../reports/html.js';
import type { ReplySettings } from '../pipeline/replyStep.js';
import { approve, countRetryableFailed, listPending, reject, retryAllFailed, ReviewError } from './reviewService.js';

export interface ReviewRouteOptions {
  db: DB;
  reportToken: string;
  settings: Pick<ReplySettings, 'delayMinSec' | 'delayMaxSec' | 'reviewMode'>;
  /** Para despertar al worker cuando se reencolan comentarios. */
  onRequeued?: () => void;
}

/** Página de revisión para el móvil: lista, edita, aprueba o rechaza las respuestas pendientes. */
export const reviewRoutes: FastifyPluginAsync<ReviewRouteOptions> = async (app, opts) => {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.addHook('onRequest', requireToken(opts.reportToken));

  app.get<{ Querystring: { msg?: string } }>('/review', async (req, reply) => {
    const token = requestToken(req)!;
    const t = encodeURIComponent(token);
    const items = listPending(opts.db);
    const cards = items
      .map(
        (c) => `<div class="card">
  <div class="muted">${esc(c.question ?? '(sin pregunta)')}${c.permalink ? ` · <a href="${esc(c.permalink)}" rel="noreferrer">vídeo</a>` : ''}</div>
  <div><span class="label">@${esc(c.username ?? '?')}</span>: ${esc(c.text)}</div>
  ${c.answer_label ? `<div class="muted">etiqueta: ${esc(c.answer_label)}${c.character_name ? ` · personaje: ${esc(c.character_name)}` : ''}</div>` : ''}
  <form method="post" action="/review/${esc(c.comment_id)}/approve?token=${t}">
    <textarea name="reply_text" rows="2" maxlength="200">${esc(c.reply_text ?? '')}</textarea>
    <div class="muted">${esc(c.reply_reason ?? '')}</div>
    <button class="ok" type="submit">Aprobar</button>
    <button class="ko" type="submit" formaction="/review/${esc(c.comment_id)}/reject?token=${t}">Rechazar</button>
  </form>
</div>`,
      )
      .join('\n');
    const msg = req.query.msg ? `<div class="card">${esc(req.query.msg)}</div>` : '';
    const failed = countRetryableFailed(opts.db);
    const retry = failed
      ? `<form method="post" action="/review/retry-failed?token=${t}"><button class="ko" type="submit">Reintentar ${failed} comentario${failed === 1 ? '' : 's'} fallido${failed === 1 ? '' : 's'}</button></form>`
      : '';
    return reply.type('text/html; charset=utf-8').send(
      page(
        'Revisión',
        `${nav(token)}
<h1>Respuestas pendientes (${items.length})</h1>
<p class="muted">${opts.settings.reviewMode ? 'REVIEW_MODE activo: nada se publica sin tu aprobación.' : 'REVIEW_MODE desactivado: las respuestas nuevas se publican solas.'} Al aprobar, se publica tras el delay aleatorio y respetando el tope por hora.</p>
${msg}
${retry}
${items.length > 1 ? `<form method="post" action="/review/approve-all?token=${t}"><button class="ok" type="submit">Aprobar todas sin cambios</button></form>` : ''}
${cards || '<p class="muted">No hay nada pendiente.</p>'}`,
      ),
    );
  });

  const back = (token: string, msg: string) => `/review?token=${encodeURIComponent(token)}&msg=${encodeURIComponent(msg)}`;

  app.post<{ Params: { id: string }; Body: { reply_text?: string } }>('/review/:id/approve', async (req, reply) => {
    const token = requestToken(req)!;
    try {
      const row = approve(opts.db, req.params.id, opts.settings, { ...(req.body?.reply_text !== undefined ? { text: req.body.reply_text } : {}) });
      return reply.redirect(back(token, `✔ Aprobada: ${row.reply_text}`), 303);
    } catch (err) {
      if (err instanceof ReviewError) return reply.redirect(back(token, `✖ ${err.message}`), 303);
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/review/:id/reject', async (req, reply) => {
    const token = requestToken(req)!;
    try {
      reject(opts.db, req.params.id);
      return reply.redirect(back(token, '✔ Rechazada'), 303);
    } catch (err) {
      if (err instanceof ReviewError) return reply.redirect(back(token, `✖ ${err.message}`), 303);
      throw err;
    }
  });

  app.post('/review/retry-failed', async (req, reply) => {
    const token = requestToken(req)!;
    const n = retryAllFailed(opts.db);
    opts.onRequeued?.();
    return reply.redirect(back(token, `✔ ${n} comentario${n === 1 ? '' : 's'} vuelve${n === 1 ? '' : 'n'} a la cola`), 303);
  });

  app.post('/review/approve-all', async (req, reply) => {
    const token = requestToken(req)!;
    let n = 0;
    for (const c of listPending(opts.db)) {
      try {
        approve(opts.db, c.comment_id, opts.settings);
        n++;
      } catch {
        // si alguna ya no está pendiente, se sigue con las demás
      }
    }
    return reply.redirect(back(token, `✔ ${n} aprobadas`), 303);
  });
};
