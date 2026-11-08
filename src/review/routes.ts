import type { FastifyPluginAsync } from 'fastify';
import type { DB } from '../db/index.js';
import { requestToken, requireToken } from '../reports/auth.js';
import { esc, nav, page } from '../reports/html.js';
import type { ReplySettings } from '../pipeline/replyStep.js';
import {
  approve,
  countInQueue,
  countRetryableFailed,
  listPending,
  listRetryableFailed,
  redoPending,
  reject,
  retryAllFailed,
  ReviewError,
} from './reviewService.js';

export interface ReviewRouteOptions {
  db: DB;
  reportToken: string;
  settings: Pick<ReplySettings, 'delayMinSec' | 'delayMaxSec' | 'reviewMode'>;
  /** Para despertar al worker cuando se reencolan comentarios. */
  onRequeued?: () => void;
  /** Con varias cuentas: "@cuenta" de cada comentario (se muestra en la tarjeta). */
  accountLabel?: (accountId: string | null) => string;
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
  <div class="muted">${opts.accountLabel ? `<b>${esc(opts.accountLabel(c.account_id))}</b> · ` : ''}${esc(c.question ?? '(sin pregunta)')}${c.permalink ? ` · <a href="${esc(c.permalink)}" rel="noreferrer">vídeo</a>` : ''}</div>
  <div><span class="label">@${esc(c.username ?? '?')}</span>: ${esc(c.text)}</div>
  ${c.answer_label ? `<div class="muted">etiqueta: ${esc(c.answer_label)}${c.character_name ? ` · personaje: ${esc(c.character_name)}` : ''}</div>` : ''}
  <form method="post" action="/review/${esc(c.comment_id)}/approve?token=${t}">
    <textarea name="reply_text" rows="2" maxlength="200">${esc(c.reply_text ?? '')}</textarea>
    <div class="muted">${c.reply_kind === 'complaint' ? 'Queja de que no sale (solo se le responde una vez) · ' : ''}${esc(c.reply_reason ?? '')}</div>
    <button class="ok" type="submit">Aprobar</button>
    <button class="ko" type="submit" formaction="/review/${esc(c.comment_id)}/reject?token=${t}">Rechazar</button>
    <button class="redo" type="submit" formaction="/review/${esc(c.comment_id)}/redo?token=${t}">Rehacer</button>
  </form>
</div>`,
      )
      .join('\n');
    const msg = req.query.msg ? `<div class="card">${esc(req.query.msg)}</div>` : '';
    const inQueue = countInQueue(opts.db);
    const queued = inQueue
      ? `<p class="muted">Generando ${inQueue === 1 ? '1 respuesta' : `${inQueue} respuestas`}… <a href="/review?token=${t}">recarga</a> en unos segundos.</p>`
      : '';
    const failed = countRetryableFailed(opts.db);
    const failedList = failed
      ? `<details class="card"><summary>Ver ${failed === 1 ? 'el fallido' : `los ${failed} fallidos`} y por qué</summary><ul>${listRetryableFailed(opts.db)
          .map((c) => `<li><span class="label">@${esc(c.username ?? '?')}</span>: ${esc(c.text)}<br><span class="muted">${esc(friendlyError(c.last_error))}</span></li>`)
          .join('')}</ul></details>`
      : '';
    const retry = failed
      ? `<form method="post" action="/review/retry-failed?token=${t}"><button class="ko" type="submit">Reintentar ${failed} comentario${failed === 1 ? '' : 's'} fallido${failed === 1 ? '' : 's'}</button></form>${failedList}`
      : '';
    return reply.type('text/html; charset=utf-8').send(
      page(
        'Revisión',
        `${nav(token)}
<h1>Respuestas pendientes (${items.length})</h1>
<p class="muted">${opts.settings.reviewMode ? 'REVIEW_MODE activo: nada se publica sin tu aprobación.' : 'REVIEW_MODE desactivado: las respuestas nuevas se publican solas.'} Al aprobar, se publica tras el delay aleatorio y respetando el tope por hora.</p>
${msg}
${queued}
${retry}
${items.length > 1 ? `<form method="post" action="/review/approve-all?token=${t}"><button class="ok" type="submit">Aprobar todas sin cambios</button></form>` : ''}
${items.length ? `<form method="post" action="/review/redo-all?token=${t}"><button class="redo" type="submit">Rehacer ${items.length === 1 ? 'la respuesta' : `las ${items.length} respuestas`} con el prompt actual</button></form>` : ''}
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

  app.post<{ Params: { id: string } }>('/review/:id/redo', async (req, reply) => {
    const token = requestToken(req)!;
    try {
      redoPending(opts.db, req.params.id);
      opts.onRequeued?.();
      return reply.redirect(back(token, '✔ Rehaciendo la respuesta: aparecerá de nuevo en unos segundos'), 303);
    } catch (err) {
      if (err instanceof ReviewError) return reply.redirect(back(token, `✖ ${err.message}`), 303);
      throw err;
    }
  });

  app.post('/review/redo-all', async (req, reply) => {
    const token = requestToken(req)!;
    const n = redoPending(opts.db);
    opts.onRequeued?.();
    return reply.redirect(
      back(token, `✔ Rehaciendo ${n === 1 ? '1 respuesta' : `${n} respuestas`}: aparecerán de nuevo en unos segundos`),
      303,
    );
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

/** Explica en castellano los errores más habituales. */
export function friendlyError(err: string | null): string {
  if (!err) return 'sin detalle';
  if (/authentication_error|Invalid bearer token|x-api-key/i.test(err)) return 'Claude rechaza la clave (ANTHROPIC_API_KEY): revísala y luego reintenta';
  if (/not scoped to a workspace/i.test(err)) return 'La clave de Claude no pertenece a un workspace: usa una creada dentro de uno';
  if (/credit balance|billing|insufficient/i.test(err)) return 'Sin crédito en Anthropic: añade crédito y luego reintenta';
  if (/does not exist|Unsupported post request/i.test(err)) return 'El comentario ya no existe o está oculto: no se puede responder (reintentar no sirve)';
  if (/OAuth|access token/i.test(err)) return 'El token de Meta no vale (IG_ACCESS_TOKEN): genera otro';
  if (/rate limit|429|too many/i.test(err)) return 'Límite de llamadas: espera un rato y reintenta';
  return err.slice(0, 200);
}
