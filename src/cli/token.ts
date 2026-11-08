/**
 * Token de Instagram:
 *   pnpm token status     de dónde sale el token vigente, cuándo se refrescó y cuándo caduca
 *   pnpm token refresh    fuerza un refresco (Meta exige que el token tenga al menos 24 h)
 * Con varias cuentas, de todas (o de una: --cuenta <@usuario|id>).
 */
import { parseArgs } from 'node:util';
import { accountArg, bootstrapCli, fmtDate, runCli } from './common.js';

runCli(async () => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { cuenta: { type: 'string' } } });
  const cmd = positionals[0];
  if (cmd !== 'refresh' && cmd !== 'status') throw new Error('Uso: pnpm token status | pnpm token refresh [--cuenta <@usuario|id>]');
  const s = bootstrapCli();
  const accounts = values.cuenta ? [accountArg(s, values.cuenta)] : s.accounts.all;
  if (s.config.meta.login === 'unified') {
    console.log('META_LOGIN=unified: token de usuario del sistema (no caduca por defecto; se ve en la vista previa de la configuración en Meta).');
  }
  for (const a of accounts) {
    if (s.accounts.all.length > 1) console.log(`\n${s.accounts.label(a.id)} (${a.id})`);
    if (cmd === 'refresh') {
      await a.tokens.refreshIfDue(true);
      console.log('✔ Token refrescado');
    }
    const st = a.tokens.status();
    const envName = process.env[`IG_ACCESS_TOKEN_${a.id}`]?.trim() ? `IG_ACCESS_TOKEN_${a.id}` : 'IG_ACCESS_TOKEN';
    console.log(`origen: ${st.source === 'env' ? `${envName} (aún no refrescado)` : 'refrescado y guardado en la BD'}`);
    console.log(`último refresco: ${fmtDate(st.refreshedAt)} · caduca: ${fmtDate(st.expiresAt)}`);
    if (st.lastError) console.log(`último error: ${st.lastError}`);
  }
  s.db.close();
});
