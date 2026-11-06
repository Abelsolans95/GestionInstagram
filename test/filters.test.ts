import { describe, expect, it } from 'vitest';
import { insertCommentIfNew, updateComment } from '../src/db/comments.js';
import { openDb } from '../src/db/index.js';
import {
  autoRepliesInThread,
  checkSpam,
  countMentions,
  findBlockedTerm,
  hasLink,
  isOwnComment,
  parseTermList,
  staticFilterLists,
} from '../src/pipeline/filters.js';
import { isEmojiOnly, normalizeForMatch } from '../src/pipeline/text.js';

const lists = staticFilterLists(
  ['gilipoll*', 'hijo de puta', 'idiota', '# comentario', '', 'política'],
  ['gana dinero', 'mira mi perfil'],
);

describe('lista de términos (config/*.txt)', () => {
  it('ignora comentarios y líneas vacías, normaliza tildes y mayúsculas', () => {
    expect(parseTermList('# hola\n\nPolítica\nGilipoll*  # prefijo\n').terms).toEqual(['politica', 'gilipoll*']);
  });
});

describe('términos bloqueados', () => {
  it.each([
    ['eres un gilipollas', 'gilipoll*'],
    ['GILIPOLLEZ de vídeo', 'gilipoll*'],
    ['hijo de puta', 'hijo de puta'],
    ['IDIOTAAAA', 'idiota'],
    ['no me gusta la politica', 'politica'],
  ])('"%s" → %s', (text, term) => {
    expect(findBlockedTerm(text, lists)).toBe(term);
  });

  it('solo por palabras completas (no dentro de otras)', () => {
    expect(findBlockedTerm('idiotez no está en la lista', lists)).toBeNull();
    expect(findBlockedTerm('Yo quiero ser el que haga las herramientas', lists)).toBeNull();
  });
});

describe('enlaces', () => {
  it.each(['mira https://x.com/a', 'www.mitienda.es', 'entra en mitienda.shop', 'bit.ly/abc', 'escríbeme wa.me/34600'])('detecta "%s"', (t) => {
    expect(hasLink(t)).toBe(true);
  });
  it.each(['Yo quiero broooo🔥🔥🙌', 'quiero ser herrero.', 'jajaja vale... y luego qué', 'son las 3.30'])('no detecta "%s"', (t) => {
    expect(hasLink(t)).toBe(false);
  });
});

describe('spam', () => {
  it('frases de config/spam.txt', () => {
    expect(checkSpam('Gana dinero fácil desde casa', { lists })).toMatchObject({ isSpam: true });
    expect(checkSpam('MIRA MI PERFIL 🔥', { lists })).toMatchObject({ isSpam: true });
  });
  it('demasiadas menciones', () => {
    expect(countMentions('@a1 @b2 @c3 @d4 @e5 mirad')).toBe(5);
    expect(checkSpam('@a1 @b2 @c3 @d4 @e5 mirad', { lists }).isSpam).toBe(true);
    expect(checkSpam('@amigo mira esto jajaja', { lists }).isSpam).toBe(false);
  });
  it('el mismo texto repetido varias veces por el mismo usuario', () => {
    expect(checkSpam('sígueme que te sigo de vuelta', { lists, sameTextCount: 2 }).isSpam).toBe(true);
    expect(checkSpam('sígueme que te sigo de vuelta', { lists, sameTextCount: 1 }).isSpam).toBe(false);
  });
  it('los comentarios de solo emojis NO son spam (se responden)', () => {
    expect(checkSpam('🔥🔥🔥', { lists, sameTextCount: 5 }).isSpam).toBe(false);
  });
  it('los comentarios reales no son spam', () => {
    for (const t of ['Yo quiero ser el que haga las herramientas', 'yooo y si me puedes vestir de spiderman te lo agradecería', 'Yo quiero broooo🔥🔥🙌']) {
      expect(checkSpam(t, { lists }).isSpam).toBe(false);
    }
  });
});

describe('solo emojis', () => {
  it.each(['🔥🔥🙌', '🙌 🙌', '❤️‍🔥', '👍🏽!!', '🇪🇸'])('"%s" es solo emojis', (t) => expect(isEmojiOnly(t)).toBe(true));
  it.each(['Yo quiero broooo🔥🔥🙌', '123', '', 'hola'])('"%s" no', (t) => expect(isEmojiOnly(t)).toBe(false));
});

describe('comentario propio', () => {
  const own = { userId: '178', username: 'humanidaddesdecero' };
  it('por IG_USER_ID o por username (sin distinguir mayúsculas)', () => {
    expect(isOwnComment({ igUserId: '178', username: null }, own)).toBe(true);
    expect(isOwnComment({ igUserId: 'x', username: 'HumanidadDesdeCero' }, own)).toBe(true);
    expect(isOwnComment({ igUserId: 'x', username: 'otro' }, own)).toBe(false);
    expect(isOwnComment({ igUserId: null, username: null }, { userId: '178', username: null })).toBe(false);
  });
});

describe('límite de respuestas automáticas por usuario e hilo (24 h)', () => {
  it('cuenta pendientes, programadas y publicadas de las últimas 24 h, en ese hilo y de ese usuario', () => {
    const db = openDb(':memory:');
    const now = Date.now();
    const add = (id: string, user: string, parent: string, status: 'replied' | 'pending_review' | 'skipped' | 'scheduled', at = now) => {
      insertCommentIfNew(db, { commentId: id, mediaId: 'm', parentId: parent, parentChecked: true, igUserId: null, username: user, text: 't', commentedAt: at, source: 'webhook', status: 'queued' }, at);
      updateComment(db, id, { status, ...(status === 'replied' ? { replied_at: at } : {}) }, at);
    };
    add('1', 'pepe', 'T', 'replied');
    add('2', 'pepe', 'T', 'pending_review');
    add('3', 'pepe', 'T', 'skipped'); // no cuenta: no se respondió
    add('4', 'Pepe', 'OTRO', 'replied'); // otro hilo
    add('5', 'ana', 'T', 'scheduled'); // otro usuario
    add('6', 'pepe', 'T', 'replied', now - 25 * 3_600_000); // hace más de 24 h
    expect(autoRepliesInThread(db, 'T', 'PEPE', 'nuevo', now)).toBe(2);
    expect(autoRepliesInThread(db, 'T', 'ana', 'nuevo', now)).toBe(1);
  });
});

describe('normalizeForMatch', () => {
  it('quita tildes, signos y repeticiones', () => {
    expect(normalizeForMatch('¡¡Qué TONTOOOO, eh!!')).toBe('que tonto eh');
  });
});
