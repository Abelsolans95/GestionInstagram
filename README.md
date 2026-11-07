# Comentarios de Instagram · @humanidaddesdecero

Servicio que, con la API oficial de Meta (Instagram API con inicio de sesión unificado, o con
inicio de sesión de Instagram) y Claude:

1. **Responde automáticamente** a los comentarios de tus vídeos (principales y respuestas en
   hilos), con tu estilo, empezando siempre por `@usuario`.
2. **Analiza los comentarios**: qué responde cada @usuario a la pregunta de cada vídeo (p. ej. qué
   oficio quiere) y qué nombre de personaje pide, en informes legibles desde el móvil y en CSV.

Stack: Node.js 22 + TypeScript (Fastify), pnpm, SQLite (`better-sqlite3`), Claude Haiku
(`claude-haiku-5-5`), Graph API `v27.0`. Despliegue en Railway con Docker.

**Modo de conexión con Meta** (`META_LOGIN`):

| | `unified` (por defecto, recomendado por Meta) | `instagram` |
|---|---|---|
| Panel de Meta | *API setup with Unified login* | *API setup with Instagram login* |
| Host | `graph.facebook.com` | `graph.instagram.com` |
| Token | Usuario del sistema, no caduca por defecto | Usuario de Instagram, 60 días (se refresca solo) |
| Tu cuenta | `GET /{IG_USER_ID}` | `GET /me` |
| Secret de la firma | Clave secreta de la app de Meta | Instagram app secret |
| Requisitos | App en un portfolio comercial | — |

Ninguno de los dos necesita una Página de Facebook. Los endpoints de comentarios
(`/{media-id}/comments`, `/{comment-id}/replies`) son los mismos en ambos.

> 👉 **Para ponerlo en marcha, sigue [`instrucciones.md`](instrucciones.md)** (paso a paso).

## Cómo funciona

```
Meta ──POST /webhook/instagram──▶ firma OK? ──▶ INSERT OR IGNORE en `comments` (queued) ──▶ 200
                                                       │
                       worker de respuestas ◀──────────┘ (uno a uno, persistente)
                         1. ¿propio / vídeo ajeno / spam? → fin (sin análisis)
                         2. extracción con Claude → answers / participants   (siempre)
                         3. filtros de respuesta (enlaces, bloqueados, 2 por hilo/24 h…)
                         4. respuesta con Claude → validación
                         5. REVIEW_MODE → pending_review   |   si no → scheduled (+ delay aleatorio)
                       publicador (único que usa el cliente de escritura)
                         scheduled + publish_at vencido + tope por hora → POST /{comment-id}/replies
```

- **Idempotencia**: `comments.comment_id` es único; los reenvíos de Meta no se procesan dos veces.
- **Nunca se procesa en la petición del webhook**: solo se valida, se encola y se responde 200.
- **Lectura y escritura separadas**: `src/meta/readClient.ts` (solo GET) y
  `src/meta/writeClient.ts` (solo `POST /replies`). Únicamente `src/worker/publisher.ts`
  importa el de escritura; un test de arquitectura lo comprueba.

## Puesta en marcha (orden recomendado)

1. [Configura la app de Meta](#1-configurar-meta-instagram-api-con-instagram-login) y consigue el token.
2. [Despliega en Railway](#2-desplegar-en-railway) con `REVIEW_MODE=true`.
3. Configura el webhook en Meta apuntando a tu dominio de Railway y suscribe `comments`.
4. Fija las preguntas de los vídeos: `pnpm question list --refresh` y `pnpm question set …`.
5. Importa lo que ya existe: `pnpm import:comments --dry-run` y luego `pnpm import:comments`.
6. Durante los 3 primeros días revisa y aprueba desde el móvil: `https://TU_DOMINIO/review?token=…`.
7. Cuando te fíes, pon `REVIEW_MODE=false` en Railway: las respuestas se publicarán solas.

## 1. Configurar Meta

El paso a paso detallado, con el **inicio de sesión unificado**, está en
[`instrucciones.md`](instrucciones.md). Resumen:

- Cuenta de Instagram **profesional y pública** (*creator* vale) y tu cuenta personal de Facebook
  para el panel de desarrolladores. No hace falta Página de Facebook.
- App con el caso de uso **Administrar mensajes y contenido en Instagram** → *Personalizar* →
  **API setup with Unified login**:
  1. *Create new configuration* (con `instagram_basic` e `instagram_manage_comments`), con la
     URL de redirección `https://TU_DOMINIO/auth/callback`.
  2. *Generate access tokens* → invitar a tu Instagram como tester → aceptar en
     instagram.com (Configuración › Permisos de sitios web › Apps y sitios web ›
     Invitaciones de tester) → *Generate token* → `IG_ACCESS_TOKEN`. Solo se muestra una vez.
  3. `IG_USER_ID`: el `id` de
     `https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?fields=id,username&access_token=TOKEN`.
  4. `IG_APP_ID` / `IG_APP_SECRET`: *Configuración de la app › Básica* (los de la app de Meta).
  5. Webhook: callback `https://TU_DOMINIO/webhook/instagram`, tu verify token, campo `comments`, y
     `POST https://graph.facebook.com/v27.0/{IG_USER_ID}/subscribed_apps?subscribed_fields=comments&access_token=TOKEN`.
- Con Standard Access (sin App Review) basta para tu propia cuenta: la documentación indica que
  sirve para quien tiene un rol en la app, y tu Instagram lo tiene como tester.

Si tu app tiene la pestaña **API setup with Instagram login**, también vale: pon
`META_LOGIN=instagram`, usa el *Instagram app secret* y el token de esa pestaña, y saca
`IG_USER_ID` con `https://graph.instagram.com/v27.0/me?fields=user_id,username&access_token=TOKEN`.

> ⚠️ **Si el *Test* funciona pero los comentarios reales no llegan**: la guía de webhooks dice que
> la app debe estar **Live** para recibir notificaciones (y pasar a Live pide URL de política de
> privacidad y puede pedir verificación del negocio). Mientras tanto puedes activar el
> [plan B](#plan-b-leer-los-comentarios-sin-webhook): `POLL_INTERVAL_SECONDS=60`.

### Probar en local con ngrok

```bash
pnpm install
cp .env.example .env       # rellena las variables
pnpm dev                   # http://localhost:3000, recarga al guardar
ngrok http 3000            # usa https://<subdominio>.ngrok-free.app/webhook/instagram en Meta
pnpm simulate:webhook --verify --url https://<subdominio>.ngrok-free.app/webhook/instagram
```

`pnpm simulate:webhook` construye un payload `comments` como los de Meta, lo firma con tu
`IG_APP_SECRET` y lo envía:

```bash
pnpm simulate:webhook --text "Yo quiero ser el que haga las herramientas" --username cesar_h_marquez
pnpm simulate:webhook --text "jajaja" --parent 18000000000000001  # respuesta dentro de un hilo
pnpm simulate:webhook --text "hola" --times 3                     # el mismo evento 3 veces (duplicados)
pnpm simulate:webhook --text "hola" --bad-signature               # debe dar 401
pnpm simulate:webhook --text "hola" --shape flat                  # la otra forma del payload
pnpm simulate:webhook --text "hola" --print                       # solo muestra el JSON
```

Con `REVIEW_MODE=true` nada se publica, aunque el servidor sí lee de Meta (caption, comentario
padre…), así que en local necesitas un token válido para que el comentario simulado se procese.

## 2. Desplegar en Railway

1. *New Project › Deploy from GitHub repo* con este repo. Railway detecta el `Dockerfile`.
2. **Volumen** (SQLite, si no la base de datos se borra en cada despliegue): en el servicio,
   *+ New › Volume*, montado en **`/data`**. La imagen ya usa `DATABASE_PATH=/data/app.db`.
   Mantén **una sola réplica**.
3. **Variables**: las de [`.env.example`](.env.example) en *Variables* del servicio, con
   `REVIEW_MODE=true`. Railway inyecta `PORT`.
4. **Dominio público**: *Settings › Networking › Generate Domain*. Esa es la URL HTTPS del
   webhook (`https://xxx.up.railway.app/webhook/instagram`).
5. *Healthcheck*: `GET /health`.

**Comandos en producción**: la base de datos está dentro del contenedor, así que los comandos se
ejecutan ahí, con la CLI de Railway: `railway ssh` y dentro `pnpm review list`, etc. (o
`node dist/src/cli/review.js list`). No uses `railway run`: ejecuta en tu ordenador con otra base
de datos.

## Respuestas automáticas

- Modelo `claude-haiku-5-5` (`CLAUDE_MODEL`), con la salida JSON forzada por *structured outputs*:
  `{"reply": string|null, "reason": string}`. `null` = no responder.
- System prompt en [`prompts/reply.md`](prompts/reply.md): edítalo sin tocar código.
- Contexto: caption del vídeo (cacheado por vídeo), pregunta del vídeo y, si es una respuesta en
  un hilo, el texto del comentario padre.
- Validación: si no empieza por `@usuario` se añade (si empieza por otra mención, p. ej. el
  `@usuario` de los ejemplos del prompt, se sustituye); si supera **200 caracteres**, lleva enlaces
  o el JSON no parsea, se descarta y queda en el log.
- **Hilos**: la API solo admite respuestas a comentarios principales (*"replies to a reply will be
  added to the top-level comment"*), así que para una respuesta dentro de un hilo se publica sobre
  el **comentario padre** (`parent_id`), mencionando al autor.

### Filtros

| Caso | ¿Análisis? | ¿Respuesta? |
|---|---|---|
| Comentario de tu propia cuenta (`IG_USER_ID` o tu username) | no | no |
| Spam (frases de [`config/spam.txt`](config/spam.txt), 5+ menciones, mismo texto repetido) | no | no |
| Comentario en un vídeo que no es tuyo (menciones) | no | no |
| Status `imported` | — | **nunca** |
| Lleva enlaces | sí | no |
| Insultos / temas de [`config/blocked.txt`](config/blocked.txt) | sí | no |
| Ya hay 2 respuestas automáticas a ese usuario en ese hilo en las últimas 24 h | sí | no |
| Comentario oculto (Meta no permite responderlo) | sí | no |
| Más antiguo que `MAX_REPLY_AGE_HOURS` (si lo activas; por defecto se responde todo) | sí | no |
| El modelo devuelve `reply: null` (insultos, polémica…) | sí | no |
| **Solo emojis** | sí | **sí** |

Las listas de `config/` se releen al cambiar el fichero: una palabra o frase por línea, sin
distinguir mayúsculas ni tildes, por palabras completas; `*` al final = prefijo.

### Delay, tope por hora y reintentos

- Cada respuesta se programa a `ahora + aleatorio(REPLY_DELAY_MIN, REPLY_DELAY_MAX)` segundos
  (60–300 por defecto). Los delays corren en paralelo: 10 comentarios a la vez salen en 1–5 min.
- **`MAX_REPLIES_PER_HOUR`** (60) es un tope global en ventana móvil de 60 min. Solo se nota en
  picos: si llegan más de 60 en una hora, el resto espera a que haya hueco (no se pierde).
- El publicador saca como mucho una respuesta cada ~10 s para no soltar ráfagas.
- Llamadas a Meta y a Claude: 3 intentos con backoff; si fallan, el comentario queda `failed` y
  se sigue con el siguiente (`pnpm review retry <id>` para reintentarlo).
- Si una publicación falla de forma ambigua (sin respuesta de Meta o 5xx), antes de reintentar se
  comprueba si la respuesta ya está publicada en el hilo, para no duplicarla.

### Modo revisión (`REVIEW_MODE=true`)

Las respuestas se guardan como `pending_review` y **no se publica nada sin tu aprobación**. Al
aprobar, se programa con el delay aleatorio y sale respetando el tope por hora.

- Desde el móvil: `https://TU_DOMINIO/review?token=TU_REPORT_TOKEN` (editar, aprobar, rechazar,
  aprobar todas).
- Desde la terminal:
  ```bash
  pnpm review list
  pnpm review edit <comment-id> "jajaja lo vemos más adelante!!"
  pnpm review approve <comment-id> [<comment-id>...]   # o --all
  pnpm review reject <comment-id>
  pnpm review retry <comment-id>                      # vuelve a encolar uno que falló
  pnpm review retry-failed                            # vuelve a encolar todos los que fallaron
  pnpm review stats
  ```

### Token

- **`META_LOGIN=unified`**: token de usuario del sistema; según la documentación de Facebook Login
  for Business, por defecto **no caduca**. Deja de valer si quitas la app de tu portfolio
  comercial o mueves la cuenta a otro portfolio: genera otro y cambia `IG_ACCESS_TOKEN`.
- **`META_LOGIN=instagram`**: el token dura 60 días y el servicio lo refresca solo
  (`GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`) cada 7 días (lo
  comprueba cada 6 h; Meta exige que tenga al menos 24 h). El token vigente se guarda en SQLite;
  si cambias `IG_ACCESS_TOKEN` en Railway, se adopta el nuevo.

`pnpm token status` / `pnpm token refresh`.

## Análisis de comentarios

Por cada comentario (webhook o importación) se hace una **extracción** con Claude, separada de la
respuesta, con [`prompts/extract.md`](prompts/extract.md):
`{"answers_question", "answer", "answer_label", "character_name"}`.

- `answer_label`: etiqueta corta normalizada ("el que haga las herramientas" → `herrero`). Se le
  pasan al modelo las etiquetas ya usadas en ese vídeo para que reutilice las existentes.
- `character_name`: solo si propone explícitamente un nombre para su personaje.
- Si alguien responde varias veces a la misma pregunta, **vale la última** y queda marcado
  (`answers.is_latest`, `answers.n_answers`; `@usuario*` en los informes).

Tablas: `answers` (media_id, question, username, answer, answer_label, comment_id, raw_text,
created_at) y `participants` (username único, ig_user_id, character_name, first_seen, last_seen,
n_comments).

### La pregunta de cada vídeo

El sistema intenta sacarla del caption ([`prompts/question.md`](prompts/question.md)) y la guarda
por vídeo. Como a menudo solo se dice en el vídeo, puedes fijarla a mano (nunca se sobrescribe):

```bash
pnpm question list --refresh                     # tus vídeos y su pregunta
pnpm question set https://www.instagram.com/reel/XXXX/ "¿qué oficio quieres?" --reextract
pnpm question set 17900000000000001 "¿qué construimos primero?"
pnpm question get <media-id|url>
pnpm question detect <media-id|url> [--force]    # volver a intentarlo desde el caption
pnpm reextract <media-id|url>                    # re-analizar los comentarios de ese vídeo
```

### Importar los comentarios que ya existen

`pnpm import:comments` recorre los comentarios de tus vídeos (`GET /{media-id}/comments` con
paginación, incluidas las respuestas en hilos) y los pasa por la extracción **sin responderlos**.
(Se llama `import:comments` porque `pnpm import` es un comando interno de pnpm.)

> ⚠️ **Lánzala siempre con `REVIEW_MODE=true`** como red de seguridad. El comando se niega a
> ejecutarse si no (salvo con `--dry-run`).

```bash
pnpm import:comments --dry-run                         # muestra lo que extraería, no guarda nada
pnpm import:comments --dry-run --media <media-id|url>  # solo un vídeo
pnpm import:comments                                   # importa todo
pnpm import:comments --max-media 5 2> import.log       # los 5 más recientes; logs JSON aparte
```

Garantías (con tests):

- No usa la cola ni el worker de respuestas: llama directamente al módulo de extracción.
- No importa ni instancia el cliente de escritura de Meta; solo el de lectura (GET).
- Marca cada comentario importado con status `imported`; el worker nunca responde a esos,
  aunque Meta reenvíe después un webhook del mismo comentario.
- `--dry-run` no escribe nada en la base de datos.
- `test/import.test.ts`: importación con la API de Meta mockeada → ninguna petición POST.

## Informes

Protegidos con `REPORT_TOKEN`: añade `?token=TU_REPORT_TOKEN` (guarda el enlace en el móvil) o
envía `Authorization: Bearer TU_REPORT_TOKEN`.

| Ruta | Qué muestra |
|---|---|
| `GET /report` | Índice de vídeos con su pregunta |
| `GET /report/:mediaId` | La pregunta y las respuestas agrupadas por etiqueta, ordenadas por número de personas (`herrero (3): @a, @b, @c`); al final, los comentarios que no responden. `?format=csv` |
| `GET /participants` | Ficha por seguidor: @usuario, nombre de personaje y su respuesta en cada vídeo. `?format=csv` |
| `GET /review` | Respuestas pendientes de aprobar |
| `GET /status` | Estado en JSON: comentarios por estado, respuestas en la última hora, token |

## Plan B: leer los comentarios sin webhook

Si los webhooks reales no llegan, `POLL_INTERVAL_SECONDS=60` hace que el servicio lea cada minuto
los comentarios de tus `POLL_MEDIA_COUNT` (5) vídeos más recientes con el cliente de lectura y los
meta en la misma cola idempotente. Solo coge comentarios posteriores a su activación (lo anterior
se analiza con la importación, que no responde). Con webhooks funcionando, déjalo a `0`.

## Observabilidad

Logs JSON (pino). Por cada comentario, una línea `"event":"comment_processed"` con `comment_id`,
`username`, `origin` (`webhook` / `import` / `poll`), `decision`, `reason`, `label`, `latency_ms`
y `error`. Los tokens nunca aparecen en los logs. Los payloads crudos de los webhooks se guardan
30 días en la tabla `webhook_events`.

## Variables de entorno

| Variable | Por defecto | |
|---|---|---|
| `META_LOGIN` | `unified` | `unified` o `instagram` (ver arriba) |
| `IG_APP_ID` | — | ID de la app (informativo) |
| `IG_APP_SECRET` | — | Valida la firma de los webhooks (unified: clave secreta de la app de Meta) |
| `IG_ACCESS_TOKEN` | — | Token generado en el panel de Meta |
| `IG_USER_ID` | — | ID de tu cuenta profesional de Instagram |
| `WEBHOOK_VERIFY_TOKEN` | — | El mismo texto que pongas en Meta |
| `ANTHROPIC_API_KEY` | — | API key creada dentro de un workspace de la consola de Anthropic |
| `ANTHROPIC_WORKSPACE_ID` | — | Solo si la key no pertenece a un workspace (`wrkspc_…`) |
| `REPLY_DELAY_MIN` / `REPLY_DELAY_MAX` | 60 / 300 | Segundos |
| `MAX_REPLIES_PER_HOUR` | 60 | |
| `REVIEW_MODE` | true | |
| `REPORT_TOKEN` | — | 16+ caracteres aleatorios |
| `MAX_REPLY_AGE_HOURS` | 0 | 0 = responder todos |
| `LIKE_REPLIED_COMMENTS` | false | Me gusta al comentario respondido (`POST /{IG_USER_ID}/likes`). Según Meta solo con *Facebook Login* y el permiso `instagram_manage_engagement`; si lo rechaza, se desactiva solo |
| `POLL_INTERVAL_SECONDS` / `POLL_MEDIA_COUNT` | 0 / 5 | Plan B; 0 = apagado |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | |
| `META_API_VERSION` | `v27.0` | |
| `DATABASE_PATH` | `./data/app.db` (`/data/app.db` en Docker) | |
| `PORT`, `LOG_LEVEL` | 3000, info | |

Nunca subas secretos al repo: `.env` está en `.gitignore`.

## Tests

```bash
pnpm test        # unitarios: firma, filtros, idempotencia, validación del LLM, importación,
                 # extracción con los comentarios reales, informes, publicador, token…
pnpm test:live   # con Claude de verdad (necesita ANTHROPIC_API_KEY): los 4 comentarios reales
pnpm typecheck
```

En local, los comandos (`pnpm question`, `pnpm review`, …) usan el código compilado: ejecuta
`pnpm build` antes, o `pnpm tsx src/cli/question.ts …`.

## Dudas sobre la API de Meta (anotadas en vez de suponer)

- **Live / Advanced Access**: la guía de webhooks dice que la app debe estar Live y que `comments`
  requiere Advanced Access; la guía de App Review dice que para tu propia cuenta basta Standard
  Access. Ver el plan B.
- **Secreto de la firma**: la doc solo dice "App Secret". Con el login unificado el webhook es de
  la app de Meta, así que usamos su clave secreta; con `META_LOGIN=instagram`, el *Instagram app
  secret*. Si los webhooks reales dan 401 por firma inválida, prueba con el otro.
- **Forma del payload**: la doc muestra dos formas distintas (con y sin `changes`, `id` o
  `comment_id`, con o sin `parent_id`). Se aceptan todas; si falta `parent_id`, el worker lee el
  comentario para saber si es una respuesta.
- **`caption`**: la referencia de IG Media dice que es solo para Facebook Login (en
  `graph.facebook.com`, que es el host del login unificado); el changelog indica que también se
  devuelve en `graph.instagram.com`. Se pide y, si Meta lo rechaza, se sigue sin él.
- **Comentarios propios**: se comparan por `IG_USER_ID` y además por username.

## Estructura

```
src/
  server.ts            arranque: HTTP + worker + publicador + refresco de token + plan B
  app.ts               rutas (webhook, informes, revisión, estado)
  webhook/             firma, parser del payload, rutas
  queue/               cola persistente (tabla comments)
  worker/              replyWorker (cola), publisher (único que publica), poller (plan B)
  meta/                http (reintentos), readClient (GET), writeClient (POST), token
  llm/                 cliente de Claude, prompts, reply, extract, question
  pipeline/            procesado de un comentario, filtros, extracción, contexto
  importer/            importación de comentarios existentes (solo lectura)
  reports/, review/    informes y modo revisión
  cli/                 question, review, import, reextract, token
prompts/               reply.md, extract.md, question.md (editables)
config/                blocked.txt, spam.txt (editables)
scripts/               simulate-webhook.ts
test/                  tests (vitest)
```
