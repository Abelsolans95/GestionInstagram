import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import type { IgBusinessDiscovery } from '../src/meta/types.js';
import { createRadar, friendlyRadarError, loadRadarAccounts, type RadarDeps } from '../src/reports/radar.js';
import { silentLogger } from './helpers/fakes.js';

const TOKEN = 'report-token-0123456789';

const DATA: Record<string, IgBusinessDiscovery> = {
  grande: {
    username: 'grande',
    followers_count: 100_000,
    media: {
      data: [
        { id: 'g1', media_type: 'VIDEO', like_count: 5000, comments_count: 100, permalink: 'https://www.instagram.com/reel/G1/', caption: 'Día 4: ¿qué construimos?', timestamp: '2026-11-05T18:00:00+0000' },
        { id: 'g2', media_type: 'IMAGE', like_count: 90000, comments_count: 10 },
      ],
    },
  },
  pequena: {
    username: 'pequena',
    followers_count: 2000,
    media: { data: [{ id: 'p1', media_type: 'VIDEO', like_count: 900, comments_count: 300, permalink: 'https://www.instagram.com/reel/P1/', caption: 'Comenta tu oficio' }] },
  },
};

function fakeRead() {
  const calls: string[] = [];
  const read: RadarDeps['read'] = {
    businessDiscovery: async (u) => {
      calls.push(u);
      const d = DATA[u];
      if (!d) throw new Error('Meta API 400: (#100) Cannot find User with username: ' + u);
      return d;
    },
  };
  return { read, calls };
}

describe('radar de tendencias', () => {
  it('ordena los reels por lo que han funcionado para el tamaño de la cuenta; ignora fotos; explica los errores', async () => {
    const { read } = fakeRead();
    const r = await createRadar({ read, accounts: () => ['grande', 'pequena', 'noexiste'] }).build();
    expect(r.top.map((x) => [x.account, x.rate])).toEqual([['pequena', 60], ['grande', 5.1]]);
    expect(r.accounts).toEqual([
      { username: 'grande', followers: 100_000, reels: 1 },
      { username: 'pequena', followers: 2000, reels: 1 },
      { username: 'noexiste', followers: null, reels: 0, error: 'no existe o no es una cuenta profesional (empresa o creador)' },
    ]);
  });

  it('se puede probar una cuenta suelta; caché de 15 min salvo si se pide actualizar', async () => {
    const { read, calls } = fakeRead();
    let t = 0;
    const radar = createRadar({ read, accounts: () => ['grande'], now: () => t });
    const r = await radar.build({ extra: '@Pequena' });
    expect(r.accounts.map((a) => a.username)).toEqual(['pequena', 'grande']);
    await radar.build();
    expect(calls).toEqual(['pequena', 'grande']);
    await radar.build({ force: true });
    t += 16 * 60_000;
    await radar.build();
    expect(calls).toEqual(['pequena', 'grande', 'grande', 'grande']);
  });

  it('lee config/radar.txt: una por línea, con o sin @, sin comentarios ni repetidas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-'));
    const f = join(dir, 'radar.txt');
    writeFileSync(f, '# cuentas\n@Grande\npequena # la buena\n\ngrande\n');
    expect(loadRadarAccounts(f)).toEqual(['grande', 'pequena']);
    expect(loadRadarAccounts(join(dir, 'no-existe.txt'))).toEqual([]);
  });

  it('errores de permisos y de límites en castellano', () => {
    expect(friendlyRadarError('Meta API 403: (#10) Application does not have permission')).toMatch(/^Meta no da permiso/);
    expect(friendlyRadarError('Meta API 400: (#4) Application request limit reached')).toBe('límite de llamadas de Meta: prueba en un rato');
  });
});

describe('página /radar', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({
      logger: silentLogger,
      webhook: { appSecret: 's', verifyToken: 'v', enqueue: () => {} },
      reports: { db: openDb(':memory:'), reportToken: TOKEN, radar: { read: fakeRead().read, accounts: () => ['grande'] } },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('pide el token, enseña las cuentas, el ranking con enlaces y un buscador para probar otra', async () => {
    expect((await app.inject({ method: 'GET', url: '/radar' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: `/radar?token=${TOKEN}&cuenta=pequena` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Radar de tendencias');
    expect(res.body).toContain('href="https://www.instagram.com/reel/P1/"');
    expect(res.body).toContain('60% de sus seguidores');
    expect(res.body).toContain('name="cuenta"');
    expect(res.body).toContain(`/radar?token=${TOKEN}`);
  });

  it('sin radar configurado, 404', async () => {
    const other = await buildApp({
      logger: silentLogger,
      webhook: { appSecret: 's', verifyToken: 'v', enqueue: () => {} },
      reports: { db: openDb(':memory:'), reportToken: TOKEN },
    });
    expect((await other.inject({ method: 'GET', url: `/radar?token=${TOKEN}` })).statusCode).toBe(404);
    await other.close();
  });
});
