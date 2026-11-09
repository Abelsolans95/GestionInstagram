/**
 * Radar de tendencias: lee de Meta (Business Discovery, con tu token) las últimas publicaciones de
 * cuentas parecidas a la tuya y ordena sus reels por lo que han funcionado respecto a su tamaño.
 * Es para inspirarte (ganchos, preguntas, formatos), no para copiar: solo enlaza a los originales.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReadClient } from '../meta/readClient.js';
import { esc, nav, page } from './html.js';

export interface RadarDeps {
  read: Pick<ReadClient, 'businessDiscovery'>;
  /** Cuentas a vigilar (por defecto, config/radar.txt). */
  accounts?: () => string[];
  now?: () => number;
}

export interface RadarReel {
  account: string;
  followers: number | null;
  permalink: string | null;
  caption: string;
  timestamp: number | null;
  likes: number | null;
  comments: number;
  /** (me gusta + comentarios) / seguidores, en %. null si no se sabe. */
  rate: number | null;
}

export interface RadarAccount {
  username: string;
  followers: number | null;
  reels: number;
  error?: string;
}

export interface RadarResult {
  accounts: RadarAccount[];
  top: RadarReel[];
  readAt: number;
}

/** Lee config/radar.txt: una cuenta por línea, con o sin @; # para comentarios. */
export function loadRadarAccounts(path = resolve(process.cwd(), 'config', 'radar.txt')): string[] {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const u = line.replace(/#.*/, '').trim().replace(/^@/, '').toLowerCase();
    if (u) seen.add(u);
  }
  return [...seen];
}

const CACHE_MS = 15 * 60_000;

/** Con caché de 15 min por cuenta (Business Discovery tiene límites de llamadas). */
export function createRadar(deps: RadarDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: RadarAccount & { list: RadarReel[] } }>();

  async function readAccount(username: string, force: boolean): Promise<RadarAccount & { list: RadarReel[] }> {
    const hit = cache.get(username);
    if (!force && hit && now() - hit.at < CACHE_MS) return hit.value;
    let value: RadarAccount & { list: RadarReel[] };
    try {
      const bd = await deps.read.businessDiscovery(username);
      const followers = typeof bd.followers_count === 'number' ? bd.followers_count : null;
      const list = (bd.media?.data ?? [])
        .filter((m) => m.media_type === 'VIDEO')
        .map((m) => {
          const likes = typeof m.like_count === 'number' ? m.like_count : null;
          const comments = m.comments_count ?? 0;
          const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
          return {
            account: bd.username,
            followers,
            permalink: m.permalink ?? null,
            caption: (m.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
            timestamp: Number.isNaN(ts) ? null : ts,
            likes,
            comments,
            rate: followers ? Math.round((((likes ?? 0) + comments) / followers) * 1000) / 10 : null,
          };
        });
      value = { username: bd.username, followers, reels: list.length, list };
    } catch (err) {
      value = { username, followers: null, reels: 0, list: [], error: friendlyRadarError((err as Error).message) };
    }
    cache.set(username, { at: now(), value });
    return value;
  }

  return {
    async build(opts: { extra?: string; force?: boolean; limit?: number } = {}): Promise<RadarResult> {
      const names = [...(deps.accounts ?? loadRadarAccounts)()];
      const extra = opts.extra?.trim().replace(/^@/, '').toLowerCase();
      if (extra && !names.includes(extra)) names.unshift(extra);
      const read = await Promise.all(names.map((n) => readAccount(n, !!opts.force)));
      const top = read
        .flatMap((a) => a.list)
        .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || (b.likes ?? 0) + b.comments - ((a.likes ?? 0) + a.comments))
        .slice(0, opts.limit ?? 20);
      return { accounts: read.map(({ list: _l, ...a }) => a), top, readAt: now() };
    },
  };
}

/** Errores habituales de Business Discovery, en castellano. */
export function friendlyRadarError(msg: string): string {
  if (/not a valid|no es un usuario/i.test(msg)) return msg;
  if (/Cannot find User|cannot be found|does not exist|Invalid user id/i.test(msg)) {
    return 'no existe o no es una cuenta profesional (empresa o creador)';
  }
  if (/permission|not authorized|\(#10\)|\(#200\)/i.test(msg)) return `Meta no da permiso para leerla: ${msg.slice(0, 160)}`;
  if (/rate limit|too many|\(#4\)|\(#32\)/i.test(msg)) return 'límite de llamadas de Meta: prueba en un rato';
  return msg.slice(0, 200);
}

const fmtNum = (n: number | null) => (n === null ? '?' : n.toLocaleString('es-ES'));
const fmtDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short' }) : '';

export function radarHtml(r: RadarResult, token: string, tried?: string): string {
  const t = encodeURIComponent(token);
  const form = `<form method="get" action="/radar" class="card">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="search" name="cuenta" placeholder="Probar una cuenta: @usuario" value="${esc(tried ?? '')}">
  <button class="ok" type="submit">Probar</button>
</form>`;
  const accounts = r.accounts.length
    ? `<ul>${r.accounts
        .map((a) =>
          a.error
            ? `<li>@${esc(a.username)}: <span class="muted">✖ ${esc(a.error)}</span></li>`
            : `<li>@${esc(a.username)} · ${fmtNum(a.followers)} seguidores · ${a.reels} reels recientes</li>`,
        )
        .join('')}</ul>`
    : '<p class="muted">Aún no hay cuentas. Pruébalas aquí arriba y, las que te sirvan, añádelas a <code>config/radar.txt</code> en GitHub (una por línea).</p>';
  const top = r.top.length
    ? `<ol>${r.top
        .map(
          (x) => `<li class="card"><b>@${esc(x.account)}</b> · ${fmtDate(x.timestamp)}${x.permalink ? ` · <a href="${esc(x.permalink)}" rel="noreferrer">ver reel</a>` : ''}<br>
  <span class="label">${x.rate === null ? '' : `${x.rate}% de sus seguidores · `}${fmtNum(x.likes)} me gusta · ${fmtNum(x.comments)} comentarios</span>
  ${x.caption ? `<div class="muted">${esc(x.caption)}</div>` : ''}</li>`,
        )
        .join('\n')}</ol>`
    : '<p class="muted">Nada que mostrar todavía.</p>';
  return page(
    'Radar',
    `${nav(token)}
<h1>Radar de tendencias</h1>
<p class="muted">Últimos reels de cuentas parecidas a la tuya, ordenados por cuánto han funcionado para su tamaño (me gusta + comentarios respecto a sus seguidores). Es para sacar ideas, no para copiar. <a href="/radar?token=${t}&actualizar=1">Actualizar</a></p>
${form}
<h2>Cuentas</h2>
${accounts}
<h2>Los que mejor han funcionado</h2>
${top}`,
  );
}
