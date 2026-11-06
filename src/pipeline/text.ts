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
