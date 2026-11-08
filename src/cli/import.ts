/**
 * pnpm import:comments [--dry-run] [--media <id|url>]... [--max-media N] [--cuenta <@usuario|id>]
 *
 * Con varias cuentas, importa la principal salvo que indiques otra con --cuenta.
 * Recorre los comentarios de tus vídeos (incluidas las respuestas en hilos) y los pasa por la
 * extracción SIN responderlos. Ejecútalo siempre con REVIEW_MODE=true como red de seguridad.
 * Solo usa el cliente de lectura de Meta; no usa la cola ni el worker de respuestas.
 */
import { parseArgs } from 'node:util';
import { assertImportAllowed, importComments } from '../importer/importComments.js';
import { accountArg, bootstrapCli, resolveMediaId, runCli } from './common.js';

runCli(async () => {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      media: { type: 'string', multiple: true },
      'max-media': { type: 'string' },
      cuenta: { type: 'string' },
    },
  });
  const s = bootstrapCli();
  const account = accountArg(s, values.cuenta);
  const dryRun = values['dry-run'];
  assertImportAllowed({ reviewMode: s.config.replies.reviewMode, dryRun });
  const mediaIds = values.media ? await Promise.all(values.media.map((m) => resolveMediaId(s, m, account))) : undefined;
  const maxMedia = values['max-media'] ? Number.parseInt(values['max-media'], 10) : undefined;

  const who = s.accounts.all.length > 1 ? ` · cuenta ${s.accounts.label(account.id)}` : '';
  console.log(dryRun ? `Importación en modo --dry-run: no se guardará nada${who}.` : `Importando (sin responder a nadie)${who}...`);
  const summary = await importComments(account.analysis, {
    otherOwnAccounts: s.accounts.identities().filter((o) => o.userId !== account.id),
    dryRun,
    ...(mediaIds ? { mediaIds } : {}),
    ...(maxMedia !== undefined ? { maxMedia } : {}),
    print: (line) => console.log(line),
  });
  console.log('\nResumen:');
  console.log(`  vídeos: ${summary.media} · comentarios vistos: ${summary.comments}`);
  console.log(`  analizados: ${summary.imported} (responden: ${summary.answers}, no responden: ${summary.nonAnswers})`);
  console.log(`  ya conocidos: ${summary.alreadyKnown} · propios: ${summary.own} · spam: ${summary.spam} · errores: ${summary.failed}`);
  if (dryRun) console.log('  (dry-run: no se ha guardado nada)');
  s.db.close();
});
