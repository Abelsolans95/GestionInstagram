/**
 * Migraciones de esquema, en orden. Se aplican al abrir la base de datos y se registra la
 * versión en `PRAGMA user_version`. Nunca edites una migración ya desplegada: añade otra.
 * Todas las fechas se guardan como milisegundos desde epoch (INTEGER).
 */
export const MIGRATIONS: readonly string[] = [
  // 1 — fase (b): comentarios procesados (idempotencia + cola), eventos crudos y clave-valor
  `
  CREATE TABLE comments (
    comment_id        TEXT PRIMARY KEY,           -- único: Meta reenvía webhooks duplicados
    media_id          TEXT NOT NULL,
    parent_id         TEXT,                       -- comentario padre si es respuesta en un hilo
    parent_checked    INTEGER NOT NULL DEFAULT 0, -- 1 = parent_id confirmado (payload o lectura)
    thread_id         TEXT,                       -- parent_id ?? comment_id (comentario principal)
    ig_user_id        TEXT,
    username          TEXT,
    text              TEXT NOT NULL DEFAULT '',
    commented_at      INTEGER NOT NULL,           -- fecha del comentario (o de recepción)
    source            TEXT NOT NULL CHECK (source IN ('webhook', 'import', 'poll')),
    status            TEXT NOT NULL CHECK (status IN (
                        'queued', 'processing', 'skipped', 'pending_review', 'scheduled',
                        'publishing', 'replied', 'rejected', 'failed', 'imported')),
    decision          TEXT,                       -- qué se decidió (reply, own_comment, spam, ...)
    reason            TEXT,                       -- por qué
    attempts          INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    -- extracción (análisis)
    extract_status    TEXT CHECK (extract_status IN ('done', 'skipped', 'failed')),
    extracted_at      INTEGER,
    answers_question  INTEGER,
    answer            TEXT,
    answer_label      TEXT,
    character_name    TEXT,
    -- respuesta
    reply_text        TEXT,
    reply_reason      TEXT,
    reply_target_id   TEXT,                       -- comentario sobre el que se publica (/replies)
    publish_at        INTEGER,
    replied_at        INTEGER,
    reply_comment_id  TEXT,                       -- id del comentario publicado por nosotros
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE INDEX comments_status_idx      ON comments (status, created_at);
  CREATE INDEX comments_thread_user_idx ON comments (thread_id, username);
  CREATE INDEX comments_media_idx       ON comments (media_id);
  CREATE INDEX comments_username_idx    ON comments (username);
  CREATE INDEX comments_replied_at_idx  ON comments (replied_at);

  CREATE TABLE webhook_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at  INTEGER NOT NULL,
    body         TEXT NOT NULL,
    comment_ids  TEXT NOT NULL                    -- JSON array
  );
  CREATE INDEX webhook_events_received_idx ON webhook_events (received_at);

  CREATE TABLE kv (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  `,

  // 2 — fase (c): vídeos (caption cacheado + pregunta), respuestas a la pregunta y participantes
  `
  CREATE TABLE media (
    media_id             TEXT PRIMARY KEY,
    shortcode            TEXT,
    permalink            TEXT,
    caption              TEXT,
    media_type           TEXT,
    posted_at            INTEGER,
    owner_id             TEXT,
    owner_username       TEXT,
    is_own               INTEGER,                 -- 1 = vídeo tuyo, 0 = ajeno (p. ej. una mención)
    question             TEXT,
    question_source      TEXT CHECK (question_source IN ('caption', 'manual', 'none')),
    question_updated_at  INTEGER,
    fetched_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );
  CREATE INDEX media_shortcode_idx ON media (shortcode);

  CREATE TABLE answers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id      TEXT NOT NULL,
    question      TEXT,
    username      TEXT NOT NULL,
    answer        TEXT,
    answer_label  TEXT,
    comment_id    TEXT NOT NULL UNIQUE,
    raw_text      TEXT NOT NULL,
    created_at    INTEGER NOT NULL,              -- fecha del comentario
    is_latest     INTEGER NOT NULL DEFAULT 1,    -- 1 = la respuesta que cuenta (la última)
    n_answers     INTEGER NOT NULL DEFAULT 1     -- cuántas veces ha respondido a esta pregunta
  );
  CREATE INDEX answers_media_user_idx ON answers (media_id, username);
  CREATE INDEX answers_media_label_idx ON answers (media_id, answer_label);

  CREATE TABLE participants (
    username        TEXT PRIMARY KEY,
    ig_user_id      TEXT,
    character_name  TEXT,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL,
    n_comments      INTEGER NOT NULL DEFAULT 0
  );
  `,

  // 3 — fase (f): intentos de publicación (independientes de los del worker)
  `
  ALTER TABLE comments ADD COLUMN publish_attempts INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX comments_publish_idx ON comments (status, publish_at);
  `,

  // 4 — los que fallaron al publicar porque el comentario ya no existe no son "fallidos"
  `
  UPDATE comments
     SET status = 'skipped', decision = 'comment_unavailable',
         reason = 'el comentario ya no existe o está oculto: no se puede responder'
   WHERE status = 'failed' AND decision = 'publish_failed'
     AND (last_error LIKE '%does not exist%' OR last_error LIKE '%Unsupported post request%');
  `,

  // 5 — tipo de respuesta (p. ej. 'complaint': queja de que no sale; solo se responde una vez)
  `
  ALTER TABLE comments ADD COLUMN reply_kind TEXT;
  CREATE INDEX comments_user_kind_idx ON comments (username, reply_kind);
  `,

  // 6 — varias cuentas de Instagram en el mismo servicio. Las filas anteriores se asignan a la
  // cuenta principal al arrancar (assignLegacyRows, avisado con kv 'legacy_rows_pending'), porque
  // aquí no se conoce su ID. Los participantes se recalculan entonces por cuenta: es una tabla
  // derivada de comments.
  `
  INSERT INTO kv (key, value, updated_at)
    SELECT 'legacy_rows_pending', 'true', 0
    WHERE EXISTS (SELECT 1 FROM comments) OR EXISTS (SELECT 1 FROM media);
  ALTER TABLE comments ADD COLUMN account_id TEXT;
  CREATE INDEX comments_account_status_idx ON comments (account_id, status);
  ALTER TABLE media ADD COLUMN account_id TEXT;
  DROP TABLE participants;
  CREATE TABLE participants (
    account_id      TEXT NOT NULL,
    username        TEXT NOT NULL,
    ig_user_id      TEXT,
    character_name  TEXT,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL,
    n_comments      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, username)
  );
  `,

  // 7 — un token bloqueado ("API access blocked") hacía que tus vídeos se marcaran como ajenos.
  // Se vuelven a comprobar los vídeos marcados como ajenos, y los comentarios recientes que se
  // saltaron por eso pasan a fallidos para poder reintentarlos.
  `
  UPDATE media SET fetched_at = 0 WHERE is_own = 0;
  UPDATE comments
     SET status = 'failed', decision = 'error',
         last_error = 'Meta no dejó leer el vídeo (token bloqueado o no válido): reintentar cuando el token funcione'
   WHERE status = 'skipped' AND decision = 'not_own_media' AND source != 'import'
     AND created_at >= (CAST(strftime('%s', 'now') AS INTEGER) - 3 * 86400) * 1000;
  `,
];
