import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/logger.js';

describe('redactUrl', () => {
  it('oculta tokens en la query', () => {
    expect(
      redactUrl('/webhook/instagram?hub.mode=subscribe&hub.verify_token=secreto&hub.challenge=12'),
    ).toBe('/webhook/instagram?hub.mode=subscribe&hub.verify_token=[REDACTED]&hub.challenge=12');
    expect(redactUrl('/report/1?token=abc&format=csv')).toBe('/report/1?token=[REDACTED]&format=csv');
    expect(redactUrl('/x?access_token=EAA')).toBe('/x?access_token=[REDACTED]');
  });

  it('deja intactas las URLs sin parámetros sensibles', () => {
    expect(redactUrl('/health')).toBe('/health');
    expect(redactUrl('/report/1?format=csv')).toBe('/report/1?format=csv');
  });
});
