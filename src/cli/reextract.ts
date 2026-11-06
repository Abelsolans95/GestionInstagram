/**
 * pnpm reextract <media-id|url> [--only-failed]
 * Re-analiza los comentarios ya procesados de un vídeo (p. ej. tras `pnpm question set`). No responde.
 */
import { parseArgs } from 'node:util';
import { reextractMedia } from '../pipeline/reextract.js';
import { bootstrapCli, resolveMediaId, runCli } from './common.js';

runCli(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'only-failed': { type: 'boolean', default: false } },
  });
  if (!positionals[0]) throw new Error('Uso: pnpm reextract <media-id|url> [--only-failed]');
  const s = bootstrapCli();
  const mediaId = await resolveMediaId(s, positionals[0]);
  const r = await reextractMedia(s.analysis, mediaId, {
    onlyFailed: values['only-failed'],
    print: (l) => console.log(l),
  });
  console.log(`\nRe-analizados ${r.done}/${r.total} (errores: ${r.failed})`);
  s.db.close();
});
