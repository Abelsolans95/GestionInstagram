import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Prompts en prompts/*.md, editables sin tocar código. Se releen si cambia el fichero
 * (en local, al guardar; en Railway, tras el despliegue).
 */
export type PromptName = 'reply' | 'extract' | 'question';

export interface PromptStore {
  get(name: PromptName): string;
}

export function createPromptStore(dir = resolve(process.cwd(), 'prompts')): PromptStore {
  const cache = new Map<string, { mtimeMs: number; text: string }>();
  return {
    get(name) {
      const path = join(dir, `${name}.md`);
      const { mtimeMs } = statSync(path);
      const hit = cache.get(path);
      if (hit && hit.mtimeMs === mtimeMs) return hit.text;
      const text = readFileSync(path, 'utf8').trim();
      cache.set(path, { mtimeMs, text });
      return text;
    },
  };
}

/** Para tests: prompts en memoria. */
export function staticPromptStore(prompts: Partial<Record<PromptName, string>>): PromptStore {
  return {
    get(name) {
      return prompts[name] ?? `(prompt ${name})`;
    },
  };
}
