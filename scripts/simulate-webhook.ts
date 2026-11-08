/**
 * Simula un webhook de Meta contra el servidor local (o cualquier URL), firmado con IG_APP_SECRET.
 *
 *   pnpm simulate:webhook --text "Yo quiero ser el que haga las herramientas" --username cesar_h_marquez
 *   pnpm simulate:webhook --text "jajaja" --parent 18000000000000001      # respuesta dentro de un hilo
 *   pnpm simulate:webhook --text "hola" --times 3                          # mismo evento 3 veces (duplicados)
 *   pnpm simulate:webhook --verify                                         # handshake GET
 *
 * Opciones: --url, --text, --username, --user-id, --media, --comment-id, --parent,
 *           --shape changes|flat, --times N, --bad-signature, --verify, --print
 */
import '../src/env.js';
import { parseArgs } from 'node:util';
import { computeSignature } from '../src/webhook/signature.js';
import { buildCommentPayload, randomIgId, type PayloadShape } from './payload.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    text: { type: 'string' },
    username: { type: 'string', default: 'tester_local' },
    'user-id': { type: 'string', default: '17841400000000001' },
    media: { type: 'string', default: '17900000000000001' },
    'comment-id': { type: 'string' },
    parent: { type: 'string' },
    shape: { type: 'string', default: 'changes' },
    times: { type: 'string', default: '1' },
    'bad-signature': { type: 'boolean', default: false },
    verify: { type: 'boolean', default: false },
    print: { type: 'boolean', default: false },
  },
});

const url = values.url ?? `http://localhost:${process.env.PORT ?? '3000'}/webhook/instagram`;

async function verify(): Promise<void> {
  const token = process.env.WEBHOOK_VERIFY_TOKEN;
  if (!token) throw new Error('Falta WEBHOOK_VERIFY_TOKEN en el entorno (.env)');
  const challenge = String(Math.floor(Math.random() * 1e9));
  const u = new URL(url);
  u.searchParams.set('hub.mode', 'subscribe');
  u.searchParams.set('hub.verify_token', token);
  u.searchParams.set('hub.challenge', challenge);
  const res = await fetch(u);
  const body = await res.text();
  const ok = res.status === 200 && body === challenge;
  console.log(`GET handshake → ${res.status} ${ok ? 'OK (challenge devuelto)' : `FALLO: ${body}`}`);
  if (!ok) process.exitCode = 1;
}

async function send(): Promise<void> {
  if (!values.text) throw new Error('Indica el texto del comentario con --text "..."');
  if (values.shape !== 'changes' && values.shape !== 'flat') {
    throw new Error('--shape debe ser "changes" o "flat"');
  }
  const secret = process.env.IG_APP_SECRET;
  if (!secret && !values.print) throw new Error('Falta IG_APP_SECRET en el entorno (.env)');

  const payload = buildCommentPayload(
    {
      commentId: values['comment-id'] ?? randomIgId(),
      mediaId: values.media,
      text: values.text,
      username: values.username,
      userId: values['user-id'],
      parentId: values.parent,
      // Con varias cuentas (IG_USER_ID=id1,id2), la primera.
      accountId: process.env.IG_USER_ID?.split(',')[0]?.trim(),
    },
    values.shape as PayloadShape,
  );
  const body = JSON.stringify(payload);
  if (values.print) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const signature = values['bad-signature']
    ? computeSignature(body, 'secreto-incorrecto')
    : computeSignature(body, secret!);

  const times = Math.max(1, Number.parseInt(values.times, 10) || 1);
  for (let i = 1; i <= times; i++) {
    const started = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body,
    });
    const text = await res.text();
    console.log(`POST #${i} → ${res.status} ${text} (${Date.now() - started} ms)`);
    if (res.status !== 200) process.exitCode = 1;
  }
}

(values.verify ? verify() : send()).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
