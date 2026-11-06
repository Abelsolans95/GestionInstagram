/**
 * Construye payloads de webhook `comments` de Instagram para pruebas locales y tests.
 * Genera las dos formas que aparecen en la documentación de Meta (ver src/webhook/parse.ts).
 */
export type PayloadShape = 'changes' | 'flat';

export interface FakeComment {
  commentId: string;
  mediaId: string;
  text: string;
  username: string;
  userId: string;
  parentId?: string | undefined;
  accountId?: string | undefined;
  mediaProductType?: string | undefined;
}

export function buildCommentPayload(c: FakeComment, shape: PayloadShape = 'changes'): unknown {
  const time = Math.floor(Date.now() / 1000);
  const media = { id: c.mediaId, media_product_type: c.mediaProductType ?? 'REELS' };
  const from = { id: c.userId, username: c.username };

  if (shape === 'flat') {
    // Forma del ejemplo "Business Login for Instagram" (sin changes ni parent_id).
    return {
      object: 'instagram',
      entry: [
        {
          id: c.accountId ?? '0',
          time,
          field: 'comments',
          value: {
            id: c.commentId,
            from,
            text: c.text,
            media,
            ...(c.parentId ? { parent_id: c.parentId } : {}),
          },
        },
      ],
    };
  }

  // Forma con entry[].changes[] (ejemplo "Facebook Login for Business").
  return {
    object: 'instagram',
    entry: [
      {
        id: c.accountId ?? '0',
        time,
        changes: [
          {
            field: 'comments',
            value: {
              from,
              id: c.commentId,
              ...(c.parentId ? { parent_id: c.parentId } : {}),
              text: c.text,
              media,
            },
          },
        ],
      },
    ],
  };
}

/** ID con aspecto de ID de Instagram (17 dígitos empezando por 17/18). */
export function randomIgId(): string {
  let s = '18';
  for (let i = 0; i < 15; i++) s += Math.floor(Math.random() * 10);
  return s;
}
