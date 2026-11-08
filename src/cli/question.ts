/**
 * Pregunta de cada vídeo:
 *   pnpm question list [--refresh]               vídeos y su pregunta (--refresh: relee tus vídeos de Meta)
 *   pnpm question get <media-id|url>
 *   pnpm question set <media-id|url> "texto" [--reextract]
 *   pnpm question detect <media-id|url> [--force] vuelve a intentar sacarla del caption
 * Con varias cuentas: --cuenta <@usuario|id> (en list, solo esa cuenta; en el resto, si la URL aún
 * no está guardada, busca solo en esa cuenta).
 */
import { parseArgs } from 'node:util';
import { getMedia, listMediaRows, setQuestion, upsertMedia } from '../db/analysis.js';
import { ensureMedia, ensureQuestion, getOwnIdentity, mediaUpsertFromApi } from '../pipeline/context.js';
import { reextractMedia } from '../pipeline/reextract.js';
import { detectQuestion } from '../llm/question.js';
import { accountArg, accountForMedia, bootstrapCli, fmtDate, resolveMediaId, runCli } from './common.js';

const USAGE = `Uso:
  pnpm question list [--refresh] [--cuenta <@usuario|id>]
  pnpm question get <media-id|url>
  pnpm question set <media-id|url> "¿qué oficio quieres?" [--reextract]
  pnpm question detect <media-id|url> [--force]`;

runCli(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      refresh: { type: 'boolean', default: false },
      reextract: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      cuenta: { type: 'string' },
    },
  });
  const [cmd, target, ...rest] = positionals;
  if (!cmd) throw new Error(USAGE);
  const s = bootstrapCli();
  const explicit = values.cuenta ? accountArg(s, values.cuenta) : undefined;
  const multi = s.accounts.all.length > 1;
  /** Media-id del argumento y la cuenta dueña del vídeo. */
  const target_ = async () => {
    if (!target) throw new Error(USAGE);
    const id = await resolveMediaId(s, target, explicit);
    return { id, account: accountForMedia(s, id, explicit) };
  };

  switch (cmd) {
    case 'list': {
      if (values.refresh) {
        for (const a of explicit ? [explicit] : s.accounts.all) {
          const own = await getOwnIdentity(a.analysis);
          let n = 0;
          for await (const m of a.read.listMedia()) {
            upsertMedia(s.db, mediaUpsertFromApi(m, own));
            n++;
          }
          console.log(`${n} vídeos leídos de Meta${multi ? ` (${s.accounts.label(a.id)})` : ''}.`);
        }
        console.log('');
      }
      const rows = listMediaRows(s.db, explicit?.id);
      if (!rows.length) console.log('No hay vídeos en la base de datos. Prueba con --refresh.');
      for (const r of rows) {
        const q = r.question ? `"${r.question}" (${r.question_source})` : r.question_source === 'none' ? '(sin pregunta en el caption)' : '(sin determinar)';
        const who = multi ? `${s.accounts.label(r.account_id)}  ` : '';
        console.log(`${fmtDate(r.posted_at)}  ${who}${r.media_id}  ${r.permalink ?? ''}\n    ${q}`);
      }
      break;
    }
    case 'get': {
      const { id, account } = await target_();
      const m = await ensureMedia(account.analysis, id);
      console.log(`${id} ${m.permalink ?? ''}\npregunta: ${m.question ?? '(ninguna)'} [${m.questionSource ?? 'sin determinar'}]\ncaption: ${m.caption ?? '(no disponible)'}`);
      break;
    }
    case 'set': {
      const text = rest.join(' ').trim();
      if (!target || !text) throw new Error(USAGE);
      const { id, account } = await target_();
      await ensureMedia(account.analysis, id);
      setQuestion(s.db, id, text, 'manual');
      console.log(`✔ Pregunta de ${id}: "${text}" (manual)`);
      if (values.reextract) {
        const r = await reextractMedia(account.analysis, id, { print: (l) => console.log(l) });
        console.log(`Re-analizados ${r.done}/${r.total} (errores: ${r.failed})`);
      } else {
        console.log(`Para re-analizar los comentarios ya procesados de este vídeo: pnpm reextract ${id}`);
      }
      break;
    }
    case 'detect': {
      const { id, account } = await target_();
      const m = await ensureMedia(account.analysis, id);
      if (m.questionSource === 'manual' && !values.force) {
        throw new Error('Este vídeo tiene una pregunta fijada a mano. Usa --force para sobrescribirla.');
      }
      if (values.force) {
        const q = await detectQuestion(s.llm, account.prompts, m.caption);
        setQuestion(s.db, id, q, q ? 'caption' : 'none');
        console.log(`pregunta: ${q ?? '(no se encontró en el caption)'}`);
      } else {
        const r = await ensureQuestion(account.analysis, { ...m, questionSource: null });
        console.log(`pregunta: ${r.question ?? '(no se encontró en el caption)'}`);
      }
      console.log(`fuente: ${getMedia(s.db, id)?.question_source ?? '—'}`);
      break;
    }
    default:
      throw new Error(USAGE);
  }
  s.db.close();
});
