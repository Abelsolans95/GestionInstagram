import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSignature, safeEqual, verifySignature } from '../src/webhook/signature.js';

const SECRET = 'app-secret-de-prueba';
const body = Buffer.from('{"object":"instagram","entry":[]}');

describe('firma X-Hub-Signature-256', () => {
  it('genera sha256=<hmac hex> sobre el cuerpo crudo', () => {
    const expected = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(computeSignature(body, SECRET)).toBe(`sha256=${expected}`);
  });

  it('acepta una firma correcta', () => {
    expect(verifySignature(body, computeSignature(body, SECRET), SECRET)).toBe(true);
  });

  it('acepta el hex en mayúsculas y con espacios alrededor', () => {
    const sig = computeSignature(body, SECRET);
    expect(verifySignature(body, `  sha256=${sig.slice(7).toUpperCase()} `, SECRET)).toBe(true);
  });

  it('rechaza si el cuerpo se ha modificado (aunque sea re-serializar el JSON)', () => {
    const sig = computeSignature(body, SECRET);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
    expect(verifySignature(reserialized, sig, SECRET)).toBe(false);
    expect(verifySignature(Buffer.from(body.toString() + ' '), sig, SECRET)).toBe(false);
  });

  it('rechaza si el secreto es otro', () => {
    expect(verifySignature(body, computeSignature(body, 'otro'), SECRET)).toBe(false);
  });

  it('rechaza cabecera ausente, vacía, duplicada o con formato inválido', () => {
    const hex = computeSignature(body, SECRET).slice(7);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, '', SECRET)).toBe(false);
    expect(verifySignature(body, [`sha256=${hex}`, `sha256=${hex}`], SECRET)).toBe(false);
    expect(verifySignature(body, hex, SECRET)).toBe(false); // sin prefijo
    expect(verifySignature(body, `sha1=${hex}`, SECRET)).toBe(false);
    expect(verifySignature(body, `sha256=${hex.slice(2)}`, SECRET)).toBe(false); // longitud
    expect(verifySignature(body, `sha256=${'z'.repeat(64)}`, SECRET)).toBe(false); // no hex
  });

  it('rechaza siempre si el secreto configurado está vacío', () => {
    expect(verifySignature(body, computeSignature(body, ''), '')).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compara strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('ab', 'abc')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
  });
});
