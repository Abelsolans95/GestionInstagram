import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Reglas de arquitectura comprobadas leyendo los imports del código:
 *  - La importación no puede alcanzar (ni directa ni indirectamente) el cliente de escritura,
 *    la cola ni el worker de respuestas.
 *  - Solo el cliente de escritura usa graphPost, y solo el publicador del worker importa el
 *    cliente de escritura.
 */
const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

function importsOf(file: string): string[] {
  const code = readFileSync(file, 'utf8');
  const specs = [...code.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter((s): s is string => !!s && s.startsWith('.'));
  return specs
    .map((s) => resolve(dirname(file), s.replace(/\.js$/, '.ts')))
    .filter((p) => existsSync(p));
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(ROOT, entry)];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...importsOf(f));
  }
  return new Set([...seen].map((f) => relative(ROOT, f)));
}

function allTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allTsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const FORBIDDEN_FOR_IMPORT = ['src/meta/writeClient.ts', 'src/queue/', 'src/worker/', 'src/server.ts'];

describe('arquitectura', () => {
  it.each(['src/cli/import.ts', 'src/importer/importComments.ts'])(
    '%s no alcanza el cliente de escritura, la cola ni el worker',
    (entry) => {
      const files = [...reachable(entry)];
      const bad = files.filter((f) => FORBIDDEN_FOR_IMPORT.some((x) => f.startsWith(x)));
      expect(bad).toEqual([]);
      // Ni siquiera la función de POST de bajo nivel (definida en http.ts, que sí es alcanzable
      // porque también contiene graphGet)
      for (const f of files.filter((x) => x !== 'src/meta/http.ts')) {
        expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/\bgraphPost\b/);
      }
    },
  );

  it('solo writeClient.ts usa graphPost', () => {
    const users = allTsFiles(SRC)
      .filter((f) => !f.endsWith('meta/http.ts'))
      .filter((f) => /\bgraphPost\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(users.every((f) => f === 'src/meta/writeClient.ts')).toBe(true);
  });

  it('solo el publicador del worker importa el cliente de escritura', () => {
    const importers = allTsFiles(SRC)
      .filter((f) => importsOf(f).some((i) => i.endsWith('meta/writeClient.ts')))
      .map((f) => relative(ROOT, f));
    expect(importers.every((f) => f === 'src/worker/publisher.ts' || f === 'src/server.ts')).toBe(true);
  });

  it('el cliente de lectura no contiene peticiones de escritura', () => {
    const code = readFileSync(join(SRC, 'meta/readClient.ts'), 'utf8');
    expect(code).not.toMatch(/graphPost|'POST'|"POST"|method:\s*'(POST|DELETE|PUT)'/);
  });
});
