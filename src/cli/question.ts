/**
 * Pregunta de cada vídeo:
 *   pnpm question list [--refresh]               vídeos y su pregunta (--refresh: relee tus vídeos de Meta)
 *   pnpm question get <media-id|url>
 *   pnpm question set <media-id|url> "texto" [--reextract]
 *   pnpm question detect <media-id|url> [--force] vuelve a intentar sacarla del caption
 */
import { parseArgs } from 'node:util';
import { getMedia, listMediaRows, setQuestion, upsertMedia } from '../db/analysis.js';
import { ensureMedia, ensureQuestion, getOwnIdentity, mediaUpsertFromApi } from '../pipeline/context.js';
import { reextractMedia } from '../pipeline/reextract.js';
import { detectQuestion } from '../llm/question.js';
import { bootstrapCli, fmtDate, resolveMediaId, runCli } from './common.js';

const USAGE = `Uso:
  pnpm question list [--refresh]
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
    },
  });
  const [cmd, target, ...rest] = positionals;
  if (!cmd) throw new Error(USAGE);
  const s = bootstrapCli();

  switch (cmd) {
    case 'list': {
      if (values.refresh) {
        const own = await getOwnIdentity(s.analysis);
        let n = 0;
        for await (const m of s.read.listMedia()) {
          upsertMedia(s.db, mediaUpsertFromApi(m, own));
          n++;
        }
        console.log(`${n} vídeos leídos de Meta.\n`);
      }
      const rows = listMediaRows(s.db);
      if (!rows.length) console.log('No hay vídeos en la base de datos. Prueba con --refresh.');
      for (const r of rows) {
        const q = r.question ? `"${r.question}" (${r.question_source})` : r.question_source === 'none' ? '(sin pregunta en el caption)' : '(sin determinar)';
        console.log(`${fmtDate(r.posted_at)}  ${r.media_id}  ${r.permalink ?? ''}\n    ${q}`);
      }
      break;
    }
    case 'get': {
      if (!target) throw new Error(USAGE);
      const id = await resolveMediaId(s, target);
      const m = await ensureMedia(s.analysis, id);
      console.log(`${id} ${m.permalink ?? ''}\npregunta: ${m.question ?? '(ninguna)'} [${m.questionSource ?? 'sin determinar'}]\ncaption: ${m.caption ?? '(no disponible)'}`);
      break;
    }
    case 'set': {
      const text = rest.join(' ').trim();
      if (!target || !text) throw new Error(USAGE);
      const id = await resolveMediaId(s, target);
      await ensureMedia(s.analysis, id);
      setQuestion(s.db, id, text, 'manual');
      console.log(`✔ Pregunta de ${id}: "${text}" (manual)`);
      if (values.reextract) {
        const r = await reextractMedia(s.analysis, id, { print: (l) => console.log(l) });
        console.log(`Re-analizados ${r.done}/${r.total} (errores: ${r.failed})`);
      } else {
        console.log(`Para re-analizar los comentarios ya procesados de este vídeo: pnpm reextract ${id}`);
      }
      break;
    }
    case 'detect': {
      if (!target) throw new Error(USAGE);
      const id = await resolveMediaId(s, target);
      const m = await ensureMedia(s.analysis, id);
      if (m.questionSource === 'manual' && !values.force) {
        throw new Error('Este vídeo tiene una pregunta fijada a mano. Usa --force para sobrescribirla.');
      }
      if (values.force) {
        const q = await detectQuestion(s.llm, s.prompts, m.caption);
        setQuestion(s.db, id, q, q ? 'caption' : 'none');
        console.log(`pregunta: ${q ?? '(no se encontró en el caption)'}`);
      } else {
        const r = await ensureQuestion(s.analysis, { ...m, questionSource: null });
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
