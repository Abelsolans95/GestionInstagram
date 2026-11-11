/** Utilidades de texto compartidas por filtros, etiquetas e informes. */

/** Minúsculas y sin tildes/diacríticos. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * Normaliza para comparar palabras: sin tildes, minúsculas, solo letras/números separados por un
 * espacio, y letras repetidas 3+ veces reducidas a una ("tontooo" → "tonto").
 */
export function normalizeForMatch(s: string): string {
  return fold(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/(\p{L})\1{2,}/gu, '$1')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Longitud en caracteres visibles aproximados (puntos de código, no unidades UTF-16). */
/**
 * Sustituye los "medios emojis" (surrogates sueltos, p. ej. tras recortar un texto por la mitad de
 * un emoji) por �. La API de Anthropic rechaza el JSON si llevan uno ("unexpected end of hex escape").
 */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

export function charLength(s: string): number {
  return [...s].length;
}

// Pictogramas, tonos de piel, banderas (indicadores regionales), ZWJ, selectores y keycap.
const EMOJI_ONLY =
  /^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}‍️⃣\s!¡?¿.]+$/u;
const HAS_EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;

/** true si el comentario es solo emojis (y signos/espacios). "🔥🔥🙌" → true. */
export function isEmojiOnly(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && HAS_EMOJI.test(t) && EMOJI_ONLY.test(t);
}

/** Palabras de 1–2 letras que sí dicen algo ("yo" para apuntarse, "si", "no"…). */
const SHORT_WORDS = new Set(['yo', 'si', 'no', 'ok', 'ya', 'va', 'tu', 'ti', 'mi', 'xd', 'ey', 'oe']);
/** Risas, que sí se responden. */
const LAUGH_UNITS = new Set(['ja', 'je', 'ji', 'jo', 'ha', 'he', 'hi', 'js', 'jsj', 'jaj', 'xd', 'lol', 'kk', 'k']);

/**
 * true si el comentario es solo letras sueltas sin sentido: "A", "Aa", "aaaa", "Apapapa", "jjjj".
 * Una sola "palabra" (las menciones, emojis y signos no cuentan) que es una letra, la misma letra
 * repetida o una sílaba repetida. No cuenta lo que tenga sentido aunque sea corto ("yo", "si",
 * "no", "yoooo") ni las risas ("jajaja", "jsjsjs").
 */
export function isLettersOnly(text: string): boolean {
  const words = fold(text.replace(/@[\w.]+/g, ' '))
    .replace(/[^\p{L}\s]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length !== 1) return false;
  const w = words[0]!;
  if (SHORT_WORDS.has(w)) return false;
  if (w.length === 1) return true;
  if (/^(\p{L})\1+$/u.test(w)) return true;
  // Sílaba de 1–3 letras repetida 3+ veces (con hasta 2 letras sueltas al final): "apapapa".
  const m = /^(\p{L}{1,3}?)\1{2,}(\p{L}{0,2})$/u.exec(w);
  if (m && !LAUGH_UNITS.has(m[1]!) && !LAUGH_UNITS.has(w.slice(0, 2))) return true;
  return false;
}
