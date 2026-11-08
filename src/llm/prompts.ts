import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Prompts en prompts/*.md, editables sin tocar código. Se releen si cambia el fichero
 * (en local, al guardar; en Railway, tras el despliegue).
 *
 * Con varias cuentas de Instagram, cada cuenta puede tener los suyos en
 * prompts/cuentas/<usuario>/ (o prompts/cuentas/<IG_USER_ID>/):
 *  - la cuenta principal usa los de su carpeta si existen y, si no, los de prompts/;
 *  - las demás cuentas usan SOLO los de su carpeta (los de prompts/ hablan de la principal).
 *    reply.md es obligatorio; sin extract.md o question.md sus vídeos no se analizan, y
 *    historia.md es opcional.
 */
export type PromptName = 'reply' | 'extract' | 'question' | 'historia';

export interface PromptStore {
  get(name: PromptName): string;
  /** ¿Existe este prompt? (sin él, el paso correspondiente no se hace). Por defecto, sí. */
  has?(name: PromptName): boolean;
}

export function hasPrompt(store: PromptStore, name: PromptName): boolean {
  return store.has ? store.has(name) : true;
}

export const PROMPTS_DIR = resolve(process.cwd(), 'prompts');

function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function fileReader() {
  const cache = new Map<string, { mtimeMs: number; text: string }>();
  return (path: string): string | null => {
    const mtimeMs = mtime(path);
    if (mtimeMs === null) return null;
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.text;
    const text = readFileSync(path, 'utf8').trim();
    cache.set(path, { mtimeMs, text });
    return text;
  };
}

export function createPromptStore(dir = PROMPTS_DIR): PromptStore {
  const read = fileReader();
  return {
    get(name) {
      const path = join(dir, `${name}.md`);
      const text = read(path);
      if (text === null) throw new Error(`Falta el prompt ${path}`);
      return text;
    },
    has(name) {
      return mtime(join(dir, `${name}.md`)) !== null;
    },
  };
}

export class MissingPromptError extends Error {}

export interface AccountPromptOptions {
  dir?: string;
  /** La principal puede usar los prompts generales de prompts/. */
  primary: boolean;
  /** Nombres de su carpeta en prompts/cuentas/ (su @usuario y su IG_USER_ID). */
  folders: () => string[];
}

/** Prompts de una cuenta (ver arriba el orden de búsqueda). */
export function createAccountPromptStore(opts: AccountPromptOptions): PromptStore {
  const dir = opts.dir ?? PROMPTS_DIR;
  const read = fileReader();
  const candidates = (name: PromptName) => [
    ...opts.folders().filter((f) => /^[\w.-]+$/.test(f)).map((f) => join(dir, 'cuentas', f.toLowerCase(), `${name}.md`)),
    ...(opts.primary ? [join(dir, `${name}.md`)] : []),
  ];
  const find = (name: PromptName) => candidates(name).find((p) => mtime(p) !== null) ?? null;
  return {
    get(name) {
      const path = find(name);
      if (path) return read(path) ?? '';
      if (name === 'historia') return '';
      const folder = opts.folders()[0] ?? '<usuario>';
      throw new MissingPromptError(`Falta el prompt prompts/cuentas/${folder.toLowerCase()}/${name}.md de esta cuenta`);
    },
    has(name) {
      return find(name) !== null;
    },
  };
}

/** Para tests: prompts en memoria. Los que se dejan en null no existen. */
export function staticPromptStore(prompts: Partial<Record<PromptName, string | null>>): PromptStore {
  return {
    get(name) {
      const p = prompts[name];
      if (p === null) throw new MissingPromptError(`Falta el prompt ${name}`);
      return p ?? `(prompt ${name})`;
    },
    has(name) {
      return prompts[name] !== null;
    },
  };
}
