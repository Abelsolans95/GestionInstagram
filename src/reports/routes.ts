import type { FastifyPluginAsync } from 'fastify';
import type { DB } from '../db/index.js';
import { requestToken, requireToken } from './auth.js';
import { mediaReportCsv, participantsCsv } from './csv.js';
import { mediaIndexHtml, mediaReportHtml, participantsHtml } from './html.js';
import { buildMediaReport, buildParticipantsReport, listReportMedia } from './queries.js';

export interface ReportOptions {
  db: DB;
  reportToken: string;
}

export const reportRoutes: FastifyPluginAsync<ReportOptions> = async (app, opts) => {
  app.addHook('onRequest', requireToken(opts.reportToken));

  app.get('/report', async (req, reply) => {
    return reply.type('text/html; charset=utf-8').send(mediaIndexHtml(listReportMedia(opts.db), requestToken(req)!));
  });

  app.get<{ Params: { mediaId: string }; Querystring: { format?: string } }>('/report/:mediaId', async (req, reply) => {
    const report = buildMediaReport(opts.db, req.params.mediaId);
    if (!report) return reply.code(404).type('text/plain').send('Vídeo no encontrado');
    if (req.query.format === 'csv') {
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="informe-${report.mediaId}.csv"`)
        .send(mediaReportCsv(report));
    }
    return reply.type('text/html; charset=utf-8').send(mediaReportHtml(report, requestToken(req)!));
  });

  app.get<{ Querystring: { format?: string } }>('/participants', async (req, reply) => {
    const report = buildParticipantsReport(opts.db);
    if (req.query.format === 'csv') {
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="participantes.csv"')
        .send(participantsCsv(report));
    }
    return reply.type('text/html; charset=utf-8').send(participantsHtml(report, requestToken(req)!));
  });
};
