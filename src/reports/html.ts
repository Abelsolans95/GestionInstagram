import type { MediaReport, MediaSummary, ParticipantsReport } from './queries.js';

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const fmt = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' }) : '—';

/** Página base: legible en el móvil, sin dependencias externas. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --muted: #888; --card: rgba(127,127,127,.12); }
  body { font: 16px/1.45 -apple-system, system-ui, sans-serif; margin: 0 auto; max-width: 760px; padding: 16px; }
  h1 { font-size: 1.35rem; margin: .2rem 0 .6rem; }
  h2 { font-size: 1.1rem; margin: 1.4rem 0 .5rem; }
  a { color: #3b82f6; }
  .muted { color: var(--muted); font-size: .9rem; }
  .card { background: var(--card); border-radius: 12px; padding: 12px 14px; margin: 10px 0; }
  .label { font-weight: 600; }
  ul { padding-left: 1.1rem; } li { margin: .35rem 0; }
  .users { word-break: break-word; }
  details summary { cursor: pointer; }
  input[type=search] { width: 100%; font-size: 1rem; padding: 10px; border-radius: 10px; border: 1px solid #8884; box-sizing: border-box; }
  textarea { width: 100%; font: inherit; padding: 8px; border-radius: 8px; box-sizing: border-box; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0; margin: 6px 6px 0 0; cursor: pointer; }
  .ok { background: #16a34a; color: #fff; } .ko { background: #dc2626; color: #fff; } .redo { background: #2563eb; color: #fff; }
  nav a { margin-right: 12px; }
</style>
</head><body>
${body}
</body></html>`;
}

export function nav(token: string): string {
  const t = encodeURIComponent(token);
  return `<nav class="muted"><a href="/report?token=${t}">Vídeos</a><a href="/participants?token=${t}">Participantes</a><a href="/review?token=${t}">Revisión</a></nav>`;
}

export function mediaIndexHtml(items: MediaSummary[], token: string): string {
  const t = encodeURIComponent(token);
  const list = items.length
    ? items
        .map(
          (m) => `<div class="card">
  <div><a href="/report/${esc(m.mediaId)}?token=${t}"><span class="label">${esc(m.question ?? '(sin pregunta)')}</span></a></div>
  <div class="muted">${fmt(m.postedAt)} · ${plural(m.people, 'respuesta', 'respuestas')} · ${plural(m.comments, 'comentario analizado', 'comentarios analizados')}${m.permalink ? ` · <a href="${esc(m.permalink)}" rel="noreferrer">ver vídeo</a>` : ''}</div>
</div>`,
        )
        .join('\n')
    : '<p class="muted">Todavía no hay vídeos analizados.</p>';
  return page('Vídeos', `${nav(token)}<h1>Vídeos</h1>${list}`);
}

export function mediaReportHtml(r: MediaReport, token: string): string {
  const t = encodeURIComponent(token);
  const anyMultiple = r.groups.some((g) => g.people.some((p) => p.multiple));
  const groups = r.groups.length
    ? `<ul>${r.groups
        .map(
          (g) => `<li><details><summary><span class="label">${esc(g.label)} (${g.count})</span>: <span class="users">${g.people
            .map((p) => `@${esc(p.username)}${p.multiple ? '*' : ''}`)
            .join(', ')}</span></summary>
  <ul>${g.people.map((p) => `<li>@${esc(p.username)}: “${esc(p.rawText)}”${p.answer ? ` <span class="muted">→ ${esc(p.answer)}</span>` : ''}</li>`).join('')}</ul>
</details></li>`,
        )
        .join('\n')}</ul>`
    : '<p class="muted">Nadie ha respondido todavía a la pregunta.</p>';
  const non = r.nonAnswers.length
    ? `<ul>${r.nonAnswers.map((n) => `<li>@${esc(n.username ?? '?')}: ${esc(n.text)}</li>`).join('')}</ul>`
    : '<p class="muted">Ninguno.</p>';
  return page(
    r.question ?? 'Informe',
    `${nav(token)}
<h1>${esc(r.question ?? '(sin pregunta: fíjala con pnpm question set)')}</h1>
<p class="muted">${fmt(r.postedAt)} · ${plural(r.totalPeople, 'persona ha respondido', 'personas han respondido')}${r.permalink ? ` · <a href="${esc(r.permalink)}" rel="noreferrer">ver vídeo</a>` : ''} · <a href="/report/${esc(r.mediaId)}?format=csv&token=${t}">CSV</a> · <a href="/report/${esc(r.mediaId)}?format=md&token=${t}">MD</a> · <a href="/report/${esc(r.mediaId)}?format=conversaciones&token=${t}">conversaciones</a> · <a href="/report/${esc(r.mediaId)}/votos?token=${t}">votos (me gusta)</a></p>
${groups}
${anyMultiple ? '<p class="muted">* respondió varias veces; cuenta la última.</p>' : ''}
<h2>No responden a la pregunta (${r.nonAnswers.length})</h2>
${non}`,
  );
}

export function participantsHtml(r: ParticipantsReport, token: string): string {
  const t = encodeURIComponent(token);
  const cards = r.participants
    .map((p) => {
      const answers = r.media
        .filter((m) => p.answers[m.mediaId])
        .map((m) => {
          const a = p.answers[m.mediaId]!;
          return `<li><span class="muted">${esc(m.question ?? m.mediaId)}</span><br>${esc(a.label ?? a.answer ?? '')}${a.answer && a.answer !== a.label ? ` <span class="muted">(${esc(a.answer)})</span>` : ''}${a.multiple ? '*' : ''}</li>`;
        })
        .join('');
      return `<div class="card" data-q="${esc(`${p.username} ${p.characterName ?? ''}`.toLowerCase())}">
  <div><span class="label">@${esc(p.username)}</span>${p.characterName ? ` · personaje: <b>${esc(p.characterName)}</b>` : ''}</div>
  <div class="muted">${plural(p.nComments, 'comentario', 'comentarios')} · desde ${fmt(p.firstSeen)}</div>
  ${answers ? `<ul>${answers}</ul>` : ''}
</div>`;
    })
    .join('\n');
  return page(
    'Participantes',
    `${nav(token)}
<h1>Participantes (${r.participants.length})</h1>
<p class="muted"><a href="/participants?format=csv&token=${t}">CSV</a> · * respondió varias veces; cuenta la última.</p>
<input type="search" placeholder="Buscar @usuario o personaje" oninput="const q=this.value.toLowerCase();document.querySelectorAll('[data-q]').forEach(e=>e.style.display=e.dataset.q.includes(q)?'':'none')">
${cards || '<p class="muted">Todavía no hay participantes.</p>'}`,
  );
}
