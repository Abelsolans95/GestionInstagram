/**
 * pnpm reextract <media-id|url> [--only-failed]
 * Re-analiza los comentarios ya procesados de un vídeo (p. ej. tras `pnpm question set`). No responde.
 */
import { parseArgs } from 'node:util';
import { reextractMedia } from '../pipeline/reextract.js';
import { accountArg, accountForMedia, bootstrapCli, resolveMediaId, runCli } from './common.js';

runCli(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'only-failed': { type: 'boolean', default: false }, cuenta: { type: 'string' } },
  });
  if (!positionals[0]) throw new Error('Uso: pnpm reextract <media-id|url> [--only-failed] [--cuenta <@usuario|id>]');
  const s = bootstrapCli();
  const explicit = values.cuenta ? accountArg(s, values.cuenta) : undefined;
  const mediaId = await resolveMediaId(s, positionals[0], explicit);
  const r = await reextractMedia(accountForMedia(s, mediaId, explicit).analysis, mediaId, {
    onlyFailed: values['only-failed'],
    print: (l) => console.log(l),
  });
  console.log(`\nRe-analizados ${r.done}/${r.total} (errores: ${r.failed})`);
  s.db.close();
});
