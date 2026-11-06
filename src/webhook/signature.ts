import { createHmac, timingSafeEqual } from 'node:crypto';

/** Cabecera en la que Meta envía la firma de cada notificación. */
export const SIGNATURE_HEADER = 'x-hub-signature-256';

/**
 * Firma tal y como la envía Meta: `sha256=` + HMAC-SHA256 en hex del cuerpo crudo,
 * usando el app secret como clave.
 */
export function computeSignature(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/**
 * Comprueba la cabecera X-Hub-Signature-256 contra el cuerpo CRUDO (los bytes exactos recibidos;
 * re-serializar el JSON rompería la firma). Comparación en tiempo constante.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  appSecret: string,
): boolean {
  if (typeof header !== 'string' || appSecret.length === 0) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const received = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Comparación de strings en tiempo constante (para el verify token del handshake). */
export function safeEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
