import { describe, expect, it } from 'vitest';
import { getMedia, upsertMedia } from '../src/db/analysis.js';
import { openDb } from '../src/db/index.js';
import { MetaApiError } from '../src/meta/http.js';
import type { ReadClient } from '../src/meta/readClient.js';
import { ensureMedia, type AnalysisDeps } from '../src/pipeline/context.js';
import { fakeLlm, IG_USER_ID, silentLogger, testLists, testPrompts } from './helpers/fakes.js';

function deps(error: Error, meError: Error | null = error): AnalysisDeps {
  const fail = async () => {
    throw error;
  };
  const getMe = async () => {
    if (meError) throw meError;
    return { user_id: IG_USER_ID, username: 'humanidaddesdecero' };
  };
  const read = { getMe, getMedia: fail } as unknown as ReadClient;
  return { db: openDb(':memory:'), read, llm: fakeLlm(() => ({})).llm, prompts: testPrompts, lists: testLists, igUserId: IG_USER_ID, logger: silentLogger };
}

describe('vídeo que Meta no deja leer', () => {
  const missing = new MetaApiError("Unsupported get request. Object with ID 'm9' does not exist, cannot be loaded due to missing permissions", 400, 100, 33);

  it('si no existe o este token no puede verlo (y el token sí lee tu cuenta), es ajeno', async () => {
    expect((await ensureMedia(deps(missing, null), 'm9')).isOwn).toBe(false);
  });

  it('si el token tampoco puede leer tu cuenta (es de otra cuenta), falla y no se marca como ajeno', async () => {
    const d = deps(missing, missing);
    await expect(ensureMedia(d, 'm9')).rejects.toThrow(/missing permissions/);
    expect(getMedia(d.db, 'm9')).toBeUndefined();
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
