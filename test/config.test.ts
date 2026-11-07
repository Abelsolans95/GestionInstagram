import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  IG_APP_SECRET: 's',
  IG_ACCESS_TOKEN: 't',
  IG_USER_ID: '17841400000000001',
  WEBHOOK_VERIFY_TOKEN: 'v',
  ANTHROPIC_API_KEY: 'k',
  REPORT_TOKEN: '0123456789abcdef',
};

describe('configuración', () => {
  it('valores por defecto: login unificado en graph.facebook.com, v27.0, REVIEW_MODE=true', () => {
    const c = loadConfig(base);
    expect(c.meta).toMatchObject({ login: 'unified', graphUrl: 'https://graph.facebook.com', apiVersion: 'v27.0' });
    expect(c.replies).toMatchObject({ reviewMode: true, delayMinSec: 60, delayMaxSec: 300, maxPerHour: 60, maxAgeHours: 0 });
    expect(c.claude.model).toBe('claude-haiku-5-5');
  });

  it('META_LOGIN=instagram usa graph.instagram.com', () => {
    expect(loadConfig({ ...base, META_LOGIN: 'instagram' }).meta.graphUrl).toBe('https://graph.instagram.com');
  });

  it('REVIEW_MODE acepta true/false', () => {
    expect(loadConfig({ ...base, REVIEW_MODE: 'false' }).replies.reviewMode).toBe(false);
    expect(() => loadConfig({ ...base, REVIEW_MODE: 'quizá' })).toThrow(/REVIEW_MODE/);
  });

  it('dice qué variables faltan', () => {
    expect(() => loadConfig({})).toThrow(/IG_APP_SECRET[\s\S]*ANTHROPIC_API_KEY/);
  });

  it('rechaza un delay mínimo mayor que el máximo y un REPORT_TOKEN corto', () => {
    expect(() => loadConfig({ ...base, REPLY_DELAY_MIN: '300', REPLY_DELAY_MAX: '60' })).toThrow(/REPLY_DELAY_MAX/);
    expect(() => loadConfig({ ...base, REPORT_TOKEN: 'corto' })).toThrow(/REPORT_TOKEN/);
  });

  it('IGNORED_REELS acepta URLs (se queda con el shortcode) e IDs, separados por comas o espacios', () => {
    expect(loadConfig(base).ignoredReels).toEqual([]);
    expect(
      loadConfig({ ...base, IGNORED_REELS: 'https://www.instagram.com/reel/DQx1-ab_C/?igsh=xyz, 17912345678901234 https://www.instagram.com/humanidaddesdecero/reel/ABC/' }).ignoredReels,
    ).toEqual(['DQx1-ab_C', '17912345678901234', 'ABC']);
  });

  it('detecta dos variables pegadas juntas (salto de línea dentro de un token)', () => {
    expect(() => loadConfig({ ...base, IG_ACCESS_TOKEN: 'EAAabc\nIG_USER_ID=1784' })).toThrow(/IG_ACCESS_TOKEN[\s\S]*juntado/);
    expect(() => loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-ant 123' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('ANTHROPIC_WORKSPACE_ID es opcional', () => {
    expect(loadConfig(base).claude.workspaceId).toBeNull();
    expect(loadConfig({ ...base, ANTHROPIC_WORKSPACE_ID: 'wrkspc_123' }).claude.workspaceId).toBe('wrkspc_123');
  });
});
