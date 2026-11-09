/**
 * pnpm reextract <media-id|url> [--only-failed]
 * pnpm reextract --cuenta <@usuario|id>        todos los vídeos de esa cuenta
 * Re-analiza los comentarios ya procesados de un vídeo (p. ej. tras `pnpm question set`), y analiza
 * los que quedaron pendientes (p. ej. de una cuenta que aún no tenía prompt de análisis). No responde.
 */
import { parseArgs } from 'node:util';
import { listMediaRows } from '../db/analysis.js';
import { reextractMedia } from '../pipeline/reextract.js';
import { accountArg, accountForMedia, bootstrapCli, resolveMediaId, runCli } from './common.js';

runCli(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'only-failed': { type: 'boolean', default: false }, cuenta: { type: 'string' } },
  });
  if (!positionals[0] && !values.cuenta) {
    throw new Error('Uso: pnpm reextract <media-id|url> [--only-failed] [--cuenta <@usuario|id>]  ·  pnpm reextract --cuenta <@usuario|id>');
  }
  const s = bootstrapCli();
  const explicit = values.cuenta ? accountArg(s, values.cuenta) : undefined;
  if (!positionals[0] && explicit) {
    // Todos los vídeos de la cuenta.
    let done = 0;
    let total = 0;
    let failed = 0;
    for (const m of listMediaRows(s.db, explicit.id)) {
      console.log(`\n▶ ${m.permalink ?? m.media_id}`);
      const r = await reextractMedia(explicit.analysis, m.media_id, { onlyFailed: values['only-failed'], print: (l) => console.log(l) });
      done += r.done;
      total += r.total;
      failed += r.failed;
    }
    console.log(`\nAnalizados ${done}/${total} (errores: ${failed})`);
    s.db.close();
    return;
  }
  const mediaId = await resolveMediaId(s, positionals[0]!, explicit);
  const r = await reextractMedia(accountForMedia(s, mediaId, explicit).analysis, mediaId, {
    onlyFailed: values['only-failed'],
    print: (l) => console.log(l),
  });
  console.log(`\nRe-analizados ${r.done}/${r.total} (errores: ${r.failed})`);
  s.db.close();
});
