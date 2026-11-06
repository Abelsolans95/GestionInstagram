/**
 * Token de Instagram:
 *   pnpm token status     de dónde sale el token vigente, cuándo se refrescó y cuándo caduca
 *   pnpm token refresh    fuerza un refresco (Meta exige que el token tenga al menos 24 h)
 */
import { bootstrapCli, fmtDate, runCli } from './common.js';

runCli(async () => {
  const cmd = process.argv[2];
  const s = bootstrapCli();
  if (cmd === 'refresh') {
    await s.tokens.refreshIfDue(true);
    console.log('✔ Token refrescado');
  } else if (cmd !== 'status') {
    throw new Error('Uso: pnpm token status | pnpm token refresh');
  }
  const st = s.tokens.status();
  console.log(`origen: ${st.source === 'env' ? 'IG_ACCESS_TOKEN (aún no refrescado)' : 'refrescado y guardado en la BD'}`);
  console.log(`último refresco: ${fmtDate(st.refreshedAt)} · caduca: ${fmtDate(st.expiresAt)}`);
  if (st.lastError) console.log(`último error: ${st.lastError}`);
  s.db.close();
});
