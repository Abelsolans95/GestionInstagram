import { describe, expect, it } from 'vitest';
import { getMedia, upsertMedia } from '../src/db/analysis.js';
import { openDb } from '../src/db/index.js';
import { MetaApiError } from '../src/meta/http.js';
import type { ReadClient } from '../src/meta/readClient.js';
import { ensureMedia, type AnalysisDeps } from '../src/pipeline/context.js';
import { fakeLlm, IG_USER_ID, silentLogger, testLists, testPrompts } from './helpers/fakes.js';

function deps(error: Error): AnalysisDeps {
  const fail = async () => {
    throw error;
  };
  const read = { getMe: fail, getMedia: fail } as unknown as ReadClient;
  return { db: openDb(':memory:'), read, llm: fakeLlm(() => ({})).llm, prompts: testPrompts, lists: testLists, igUserId: IG_USER_ID, logger: silentLogger };
}

describe('vídeo que Meta no deja leer', () => {
  it('si no existe o este token no puede verlo, es ajeno', async () => {
    const d = deps(new MetaApiError("Unsupported get request. Object with ID 'm9' does not exist", 400, 100, 33));
    expect((await ensureMedia(d, 'm9')).isOwn).toBe(false);
  });

  it('si el token está bloqueado o no vale, el comentario falla (se reintenta) y el vídeo no se marca como ajeno', async () => {
    for (const err of [
      new MetaApiError('API access blocked.', 400, 200),
      new MetaApiError('Invalid OAuth access token - Cannot parse access token', 400, 190),
    ]) {
      const d = deps(err);
      upsertMedia(d.db, { mediaId: 'm1', accountId: IG_USER_ID, shortcode: 'A', permalink: null, caption: 'x', mediaType: 'VIDEO', postedAt: 1, ownerId: IG_USER_ID, ownerUsername: null, isOwn: true }, 0);
      await expect(ensureMedia(d, 'm1')).rejects.toThrow(err.message);
      expect(getMedia(d.db, 'm1')!.is_own).toBe(1);
    }
  });
});
