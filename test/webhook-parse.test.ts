import { describe, expect, it } from 'vitest';
import { parseWebhookPayload } from '../src/webhook/parse.js';
import { buildCommentPayload } from '../scripts/payload.js';

const base = {
  commentId: '18000000000000010',
  mediaId: '17900000000000001',
  text: 'Yo quiero ser el que haga las herramientas',
  username: 'cesar_h_marquez',
  userId: '17841400000000099',
  accountId: '17841400000000001',
};

describe('parseWebhookPayload', () => {
  it('entiende la forma entry[].changes[]', () => {
    const { comments, ignored } = parseWebhookPayload(buildCommentPayload(base, 'changes'));
    expect(ignored).toEqual([]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      commentId: base.commentId,
      mediaId: base.mediaId,
      text: base.text,
      fromId: base.userId,
      fromUsername: base.username,
      parentId: null,
      mediaProductType: 'REELS',
      accountId: base.accountId,
    });
    expect(typeof comments[0]!.sentAt).toBe('number');
  });

  it('entiende la forma plana del ejemplo de Instagram Login (entry.field/value)', () => {
    const { comments } = parseWebhookPayload(buildCommentPayload(base, 'flat'));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ commentId: base.commentId, fromUsername: base.username });
  });

  it('recoge parent_id cuando es una respuesta dentro de un hilo', () => {
    const { comments } = parseWebhookPayload(
      buildCommentPayload({ ...base, parentId: '18000000000000001' }, 'changes'),
    );
    expect(comments[0]!.parentId).toBe('18000000000000001');
  });

  it('acepta el id en value.comment_id (ejemplo de Facebook Login)', () => {
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: '1',
          time: 1,
          changes: [
            {
              field: 'comments',
              value: {
                from: { id: '2', username: 'u' },
                comment_id: '555',
                parent_id: '444',
                text: 'hola',
                media: { id: 777 },
              },
            },
          ],
        },
      ],
    };
    const { comments } = parseWebhookPayload(payload);
    expect(comments[0]).toMatchObject({ commentId: '555', parentId: '444', mediaId: '777' });
  });

  it('acepta el payload envuelto en un array, como en los ejemplos de la documentación', () => {
    const { comments } = parseWebhookPayload([buildCommentPayload(base, 'flat')]);
    expect(comments).toHaveLength(1);
  });

  it('devuelve varios comentarios si Meta agrupa notificaciones', () => {
    const a = buildCommentPayload({ ...base, commentId: '1' }) as { entry: unknown[] };
    const b = buildCommentPayload({ ...base, commentId: '2' }) as { entry: unknown[] };
    const { comments } = parseWebhookPayload({ object: 'instagram', entry: [...a.entry, ...b.entry] });
    expect(comments.map((c) => c.commentId)).toEqual(['1', '2']);
  });

  it('acepta comentarios sin texto (texto vacío)', () => {
    const p = buildCommentPayload(base) as any;
    delete p.entry[0].changes[0].value.text;
    expect(parseWebhookPayload(p).comments[0]!.text).toBe('');
  });

  it('ignora live_comments, otros campos y objetos que no son instagram', () => {
    const live = buildCommentPayload(base) as any;
    live.entry[0].changes[0].field = 'live_comments';
    expect(parseWebhookPayload(live)).toMatchObject({
      comments: [],
      ignored: [{ field: 'live_comments' }],
    });

    const msgs = { object: 'instagram', entry: [{ id: '1', time: 1, messaging: [{}] }] };
    expect(parseWebhookPayload(msgs).comments).toEqual([]);

    expect(parseWebhookPayload({ object: 'page', entry: [] }).ignored).toHaveLength(1);
    expect(parseWebhookPayload(null).comments).toEqual([]);
    expect(parseWebhookPayload('texto').comments).toEqual([]);
  });

  it('ignora comentarios sin id o sin media', () => {
    const p = buildCommentPayload(base) as any;
    delete p.entry[0].changes[0].value.media;
    expect(parseWebhookPayload(p)).toMatchObject({ comments: [], ignored: [{ field: 'comments' }] });
  });
});
