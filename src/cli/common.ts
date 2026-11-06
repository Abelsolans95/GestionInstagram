import '../env.js';
import { getMedia, getMediaByShortcode, upsertMedia } from '../db/analysis.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { getOwnIdentity, mediaUpsertFromApi } from '../pipeline/context.js';
import { createCoreServices, type CoreServices } from '../services.js';

/** Arranca los servicios para un comando CLI. Logs JSON a stderr; salida legible a stdout. */
export function bootstrapCli(): CoreServices {
  const config = loadConfig();
  const logger = createLogger(process.env.CLI_LOG_LEVEL ?? config.logLevel, 2);
  return createCoreServices(config, logger);
}

/** Saca el shortcode de una URL de Instagram (/p/, /reel/, /reels/, /tv/). */
export function shortcodeFromUrl(input: string): string | null {
  const m = /instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(input);
  return m?.[1] ?? null;
}

/** Acepta un media-id numérico o una URL del vídeo y devuelve el media-id. */
export async function resolveMediaId(s: CoreServices, input: string): Promise<string> {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const shortcode = shortcodeFromUrl(trimmed);
  if (!shortcode) throw new Error(`No reconozco "${input}": usa el media-id o la URL del vídeo`);
  const cached = getMediaByShortcode(s.db, shortcode);
  if (cached) return cached.media_id;
  // No está en caché: recorremos tus vídeos (GET /{ig-user-id}/media) hasta encontrarlo.
  const own = await getOwnIdentity(s.analysis);
  for await (const m of s.read.listMedia()) {
    if (!getMedia(s.db, m.id)) upsertMedia(s.db, mediaUpsertFromApi(m, own));
    if (m.shortcode === shortcode) return m.id;
  }
  throw new Error(`No encuentro ningún vídeo tuyo con shortcode ${shortcode}`);
}

export function fmtDate(ms: number | null): string {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

/** Ejecuta un comando CLI mostrando el error de forma legible. */
export function runCli(main: () => Promise<void>): void {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
