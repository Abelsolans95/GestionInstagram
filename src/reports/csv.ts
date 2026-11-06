import type { MediaReport, ParticipantsReport } from './queries.js';

/** Escapa un valor CSV y neutraliza fórmulas (=, +, -, @) para que Excel no las ejecute. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  // BOM para que Excel abra bien los acentos y emojis.
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '');

export function mediaReportCsv(r: MediaReport): string {
  const rows: unknown[][] = [
    ['media_id', 'pregunta', 'etiqueta', 'personas_en_etiqueta', 'usuario', 'respuesta', 'comentario', 'fecha', 'varias_respuestas', 'comment_id'],
  ];
  for (const g of r.groups) {
    for (const p of g.people) {
      rows.push([r.mediaId, r.question, g.label, g.count, p.username, p.answer, p.rawText, iso(p.createdAt), p.multiple ? p.nAnswers : '', p.commentId]);
    }
  }
  for (const n of r.nonAnswers) {
    rows.push([r.mediaId, r.question, '(no responde a la pregunta)', '', n.username, '', n.text, iso(n.createdAt), '', n.commentId]);
  }
  return toCsv(rows);
}

export function participantsCsv(r: ParticipantsReport): string {
  const header = ['usuario', 'personaje', 'n_comentarios', 'primera_vez', 'ultima_vez', ...r.media.map((m) => m.question ?? m.mediaId)];
  const rows: unknown[][] = [header];
  for (const p of r.participants) {
    rows.push([
      p.username,
      p.characterName,
      p.nComments,
      iso(p.firstSeen),
      iso(p.lastSeen),
      ...r.media.map((m) => {
        const a = p.answers[m.mediaId];
        if (!a) return '';
        return `${a.label ?? ''}${a.answer && a.answer !== a.label ? ` (${a.answer})` : ''}${a.multiple ? ' *' : ''}`;
      }),
    ]);
  }
  return toCsv(rows);
}
