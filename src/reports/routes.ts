import type { FastifyPluginAsync } from 'fastify';
import type { DB } from '../db/index.js';
import { requestToken, requireToken } from './auth.js';
import { mediaConversationsMarkdown } from './conversations.js';
import { mediaReportCsv, participantsCsv } from './csv.js';
import { mediaIndexHtml, mediaReportHtml, participantsHtml, type AccountLabel } from './html.js';
import { mediaReportMarkdown } from './markdown.js';
import { buildMediaReport, buildParticipantsReport, listReportMedia } from './queries.js';
import { buildVotes, votesErrorHtml, votesHtml, type VotesDeps } from './votes.js';

export interface ReportOptions {
  db: DB;
  reportToken: string;
  /**
   * Para contar votos con me gusta (lee de Meta con la cuenta del vídeo). Sin esto,
   * /report/:mediaId/votos da 404.
   */
  votes?: VotesDeps | ((mediaId: string) => VotesDeps);
  /** Tus cuentas si hay más de una (la principal primero); vacío o sin esto, una sola. */
  accounts?: () => AccountLabel[];
}

export const reportRoutes: FastifyPluginAsync<ReportOptions> = async (app, opts) => {
  app.addHook('onRequest', requireToken(opts.reportToken));

  app.get('/report', async (req, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .send(mediaIndexHtml(listReportMedia(opts.db), requestToken(req)!, opts.accounts?.() ?? []));
  });

  app.get<{ Params: { mediaId: string }; Querystring: { format?: string } }>('/report/:mediaId', async (req, reply) => {
    if (req.query.format === 'conversaciones') {
      const md = mediaConversationsMarkdown(opts.db, req.params.mediaId);
      if (!md) return reply.code(404).type('text/plain').send('Vídeo no encontrado');
      return reply
        .type('text/markdown; charset=utf-8')
        .header('content-disposition', `attachment; filename="conversaciones-${req.params.mediaId}.md"`)
        .send(md);
    }
    const report = buildMediaReport(opts.db, req.params.mediaId);
    if (!report) return reply.code(404).type('text/plain').send('Vídeo no encontrado');
    if (req.query.format === 'csv') {
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="informe-${report.mediaId}.csv"`)
        .send(mediaReportCsv(report));
    }
    if (req.query.format === 'md') {
      return reply
        .type('text/markdown; charset=utf-8')
        .header('content-disposition', `attachment; filename="informe-${report.mediaId}.md"`)
        .send(mediaReportMarkdown(report));
    }
    return reply.type('text/html; charset=utf-8').send(mediaReportHtml(report, requestToken(req)!));
  });

  app.get<{ Params: { mediaId: string } }>('/report/:mediaId/votos', async (req, reply) => {
    const token = requestToken(req)!;
    if (!opts.votes) return reply.code(404).type('text/plain').send('Votos no disponibles');
    try {
      const deps = typeof opts.votes === 'function' ? opts.votes(req.params.mediaId) : opts.votes;
      const votes = await buildVotes(opts.db, deps, req.params.mediaId);
      if (!votes) return reply.code(404).type('text/plain').send('Vídeo no encontrado');
      return reply.type('text/html; charset=utf-8').send(votesHtml(votes, token));
    } catch (err) {
      req.log.warn({ media_id: req.params.mediaId, err: (err as Error).message }, 'no se pudieron leer los me gusta');
      return reply.code(502).type('text/html; charset=utf-8').send(votesErrorHtml(req.params.mediaId, token, (err as Error).message));
    }
  });

  app.get<{ Querystring: { format?: string; cuenta?: string } }>('/participants', async (req, reply) => {
    // Con varias cuentas, los participantes son de una cuenta (?cuenta=<id o usuario>; por defecto la principal).
    const list = opts.accounts?.() ?? [];
    const wanted = req.query.cuenta?.trim().replace(/^@/, '').toLowerCase();
    const current = list.length
      ? (list.find((a) => a.id === wanted || a.label.replace(/^@/, '').toLowerCase() === wanted) ?? list[0]!)
      : null;
    const report = buildParticipantsReport(opts.db, current?.id ?? null);
    if (req.query.format === 'csv') {
      const suffix = current ? `-${current.label.replace(/^@/, '').replace(/[^\w.-]/g, '')}` : '';
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="participantes${suffix}.csv"`)
        .send(participantsCsv(report));
    }
    return reply
      .type('text/html; charset=utf-8')
      .send(participantsHtml(report, requestToken(req)!, current ? { list, current } : null));
  });
};
