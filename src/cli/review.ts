/**
 * Modo revisión desde la terminal (también hay página para el móvil: /review?token=...):
 *   pnpm review list
 *   pnpm review edit <comment-id> "nuevo texto"
 *   pnpm review approve <comment-id>... | --all
 *   pnpm review reject <comment-id>...
 *   pnpm review retry <comment-id>          (vuelve a encolar uno en 'failed')
 *   pnpm review retry-failed                (vuelve a encolar todos los 'failed')
 *   pnpm review stats
 */
import { parseArgs } from 'node:util';
import { countByStatus } from '../db/comments.js';
import { approve, editReply, listPending, reject, retryAllFailed, retryFailed } from '../review/reviewService.js';
import { bootstrapCli, fmtDate, runCli } from './common.js';

const USAGE = `Uso:
  pnpm review list
  pnpm review edit <comment-id> "nuevo texto"
  pnpm review approve <comment-id>... | --all
  pnpm review reject <comment-id>...
  pnpm review retry <comment-id>
  pnpm review retry-failed
  pnpm review stats`;

runCli(async () => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { all: { type: 'boolean', default: false } } });
  const [cmd, ...args] = positionals;
  if (!cmd) throw new Error(USAGE);
  const s = bootstrapCli();
  const settings = s.config.replies;

  switch (cmd) {
    case 'list': {
      const items = listPending(s.db);
      if (!items.length) console.log('No hay respuestas pendientes.');
      for (const c of items) {
        console.log(
          `\n[${c.comment_id}] ${fmtDate(c.created_at)} · ${c.question ?? '(sin pregunta)'}\n  @${c.username}: ${c.text}\n  → ${c.reply_text}\n    (${c.reply_reason ?? ''})`,
        );
      }
      console.log(`\n${items.length} pendientes. REVIEW_MODE=${settings.reviewMode}`);
      break;
    }
    case 'edit': {
      const [id, ...words] = args;
      if (!id || !words.length) throw new Error(USAGE);
      console.log(`✔ ${editReply(s.db, id, words.join(' '))}`);
      break;
    }
    case 'approve': {
      const ids = values.all ? listPending(s.db).map((c) => c.comment_id) : args;
      if (!ids.length) throw new Error(USAGE);
      for (const id of ids) {
        const row = approve(s.db, id, settings);
        console.log(`✔ ${id} se publicará a partir de ${fmtDate(row.publish_at)}: ${row.reply_text}`);
      }
      break;
    }
    case 'reject': {
      if (!args.length) throw new Error(USAGE);
      for (const id of args) {
        reject(s.db, id);
        console.log(`✔ ${id} rechazada`);
      }
      break;
    }
    case 'retry': {
      if (!args[0]) throw new Error(USAGE);
      retryFailed(s.db, args[0]);
      console.log(`✔ ${args[0]} vuelve a la cola`);
      break;
    }
    case 'retry-failed': {
      console.log(`✔ ${retryAllFailed(s.db)} comentarios vuelven a la cola`);
      break;
    }
    case 'stats': {
      const lastHour = s.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE replied_at >= ?').get(Date.now() - 3_600_000) as { n: number };
      console.log(JSON.stringify({ ...countByStatus(s.db), replied_last_hour: lastHour.n, max_per_hour: settings.maxPerHour, review_mode: settings.reviewMode }, null, 2));
      break;
    }
    default:
      throw new Error(USAGE);
  }
  s.db.close();
});
