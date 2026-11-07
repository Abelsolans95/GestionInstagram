import type { MediaReport } from './queries.js';

/** Escapa lo justo para que Markdown no convierta _ o * en cursivas/negritas. */
function md(text: string): string {
  return text.replace(/([\\`*_[\]#<>|])/g, '\\$1').replace(/\s+/g, ' ').trim();
}

const fmt = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' }) : '—';

/** El mismo informe que la página /report/:mediaId, en Markdown. */
export function mediaReportMarkdown(r: MediaReport): string {
  const lines: string[] = [];
  lines.push(`# ${md(r.question ?? '(sin pregunta)')}`, '');
  const meta = [fmt(r.postedAt), `${r.totalPeople} ${r.totalPeople === 1 ? 'persona ha respondido' : 'personas han respondido'}`];
  if (r.permalink) meta.push(`[ver vídeo](${r.permalink})`);
  lines.push(meta.join(' · '), '');

  lines.push('## Respuestas', '');
  if (r.groups.length === 0) lines.push('_Nadie ha respondido todavía a la pregunta._');
  for (const g of r.groups) {
    lines.push(`- **${md(g.label)} (${g.count}):** ${g.people.map((p) => `@${md(p.username)}${p.multiple ? '\\*' : ''}`).join(', ')}`);
  }
  if (r.groups.some((g) => g.people.some((p) => p.multiple))) {
    lines.push('', '_\\* respondió varias veces; cuenta la última._');
  }

  if (r.groups.length) {
    lines.push('', '## Detalle', '');
    for (const g of r.groups) {
      lines.push(`### ${md(g.label)} (${g.count})`, '');
      for (const p of g.people) {
        lines.push(`- @${md(p.username)}: “${md(p.rawText)}”${p.answer ? ` → ${md(p.answer)}` : ''}`);
      }
      lines.push('');
    }
  }

  lines.push('', `## No responden a la pregunta (${r.nonAnswers.length})`, '');
  if (r.nonAnswers.length === 0) lines.push('_Ninguno._');
  for (const n of r.nonAnswers) lines.push(`- @${md(n.username ?? '?')}: ${md(n.text)}`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
