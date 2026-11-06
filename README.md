# Comentarios de Instagram · @humanidaddesdecero

Servicio que, con la API oficial de Meta (Instagram API con Instagram Login) y Claude:

1. **Responde automáticamente** a los comentarios de tus vídeos, con tu estilo.
2. **Analiza los comentarios**: qué responde cada @usuario a la pregunta de cada vídeo
   (p. ej. qué oficio quiere) y qué nombre de personaje pide, en informes legibles desde el móvil.

Stack: Node.js 22 + TypeScript (Fastify), pnpm, SQLite. Despliegue en Railway.

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| a | Webhook: verificación de Meta + firma `X-Hub-Signature-256` + simulador | ✅ |
| b | Cola persistente + idempotencia + worker | pendiente |
| c | Extracción + tablas + pregunta del vídeo + importación | pendiente |
| d | Informes `/report/:mediaId` y `/participants` | pendiente |
| e | Filtros + respuestas con Claude + modo revisión | pendiente |
| f | Publicación + delay + tope por hora + refresco de token | pendiente |

## Desarrollo local

```bash
pnpm install
cp .env.example .env      # rellena al menos IG_APP_SECRET y WEBHOOK_VERIFY_TOKEN
pnpm dev                  # servidor en http://localhost:3000 (recarga al guardar)
pnpm test                 # tests unitarios
```

### Simular un webhook sin Meta

`pnpm simulate:webhook` construye un payload `comments` como los de Meta, lo firma con tu
`IG_APP_SECRET` y lo envía al servidor local:

```bash
pnpm simulate:webhook --verify                                    # handshake GET
pnpm simulate:webhook --text "Yo quiero ser el que haga las herramientas" --username cesar_h_marquez
pnpm simulate:webhook --text "jajaja" --parent 18000000000000001  # respuesta dentro de un hilo
pnpm simulate:webhook --text "hola" --times 3                     # el mismo evento 3 veces (duplicados)
pnpm simulate:webhook --text "hola" --bad-signature               # debe dar 401
pnpm simulate:webhook --text "hola" --shape flat                  # forma alternativa del payload
pnpm simulate:webhook --text "hola" --url https://xxxx.ngrok-free.app/webhook/instagram
```

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/webhook/instagram` | Handshake de Meta: si `hub.mode=subscribe` y `hub.verify_token` coincide con `WEBHOOK_VERIFY_TOKEN`, devuelve `hub.challenge`; si no, 403 |
| POST | `/webhook/instagram` | Valida la firma `X-Hub-Signature-256` (HMAC-SHA256 del cuerpo crudo con `IG_APP_SECRET`), encola y responde 200 al instante. Firma inválida → 401 |
| GET | `/health` | Comprobación de vida para Railway |

## Configurar Meta (Instagram API con Instagram Login)

Lo que necesitas:

- **Cuenta de Instagram profesional y pública.** Una cuenta *creator* vale: la plataforma
  da acceso a cuentas profesionales, tanto *business* como *creator*. Las cuentas privadas no
  reciben notificaciones de comentarios.
- **Una cuenta de Facebook** para registrarte como desarrollador de Meta: con la sesión de
  Facebook iniciada, entra en <https://developers.facebook.com/async/registration> y confirma
  teléfono y email. **No** necesitas una Página de Facebook (eso es solo para "Facebook Login").

Pasos (según la guía *Create a Meta app for the Instagram API*):

1. **Crear la app**: <https://developers.facebook.com/apps> → *Create App* → caso de uso
   **Other** → tipo **Business** → nombre y email.
2. **Añadir el producto Instagram** → *Set up*. Se añade **API setup with Instagram login**.
   El **Instagram App ID** y el **Instagram app secret** están en *Instagram › API setup with
   Instagram login › 3. Set up Instagram business login › Business login settings*
   → `IG_APP_ID` e `IG_APP_SECRET`.
3. **Generar el token**: en *API setup with Instagram login* → *Generate access tokens* →
   *Add account* e inicia sesión con @humanidaddesdecero. Concede los permisos
   `instagram_business_basic` e `instagram_business_manage_comments`. Copia el token → `IG_ACCESS_TOKEN`.
4. **Tu IG_USER_ID**:
   ```bash
   curl "https://graph.instagram.com/v27.0/me?fields=user_id,username&access_token=TU_TOKEN"
   ```
   El campo `user_id` es `IG_USER_ID` (es el mismo `id` que llega en `entry[].id` de los webhooks).
5. **Configurar el webhook** (sección *Configure webhooks*): *Callback URL* =
   `https://TU_DOMINIO/webhook/instagram`, *Verify token* = el valor de `WEBHOOK_VERIFY_TOKEN`
   → *Verify and save*. Meta hace el GET de verificación: el servidor tiene que estar ya
   desplegado (Railway) o expuesto con ngrok. Después, en la lista de campos, deja
   **suscrito `comments`** (puedes desuscribir los de mensajería).
6. **Activar las notificaciones para tu cuenta** (la guía lo pide para Instagram Login):
   ```bash
   curl -X POST "https://graph.instagram.com/v27.0/TU_IG_USER_ID/subscribed_apps?subscribed_fields=comments&access_token=TU_TOKEN"
   # → {"success": true}
   ```
7. **Probar**: en el panel de webhooks, botón *Test* del campo `comments` → debe llegar al
   servidor (lo verás en los logs).

> ⚠️ **Puntos dudosos de la documentación de Meta** (los anoto en vez de suponer):
> - *Live / Advanced Access*: la guía de webhooks dice que la app debe estar **Live** y que
>   `comments` requiere **Advanced Access**; la guía de *App Review* dice que para una app que solo
>   usa tu propia cuenta basta **Standard Access** y no hace falta revisión. Si el botón *Test*
>   funciona pero los comentarios reales no llegan, probablemente haya que pasar la app a Live
>   (Meta pide URL de política de privacidad y puede pedir verificación del negocio).
> - *Qué secreto firma los webhooks*: la doc solo dice "App Secret". Con Instagram Login hay un
>   *Instagram app secret* distinto del *App secret* de *App settings › Basic*. Usamos el de
>   Instagram; si los webhooks reales dan 401 por firma inválida, prueba con el otro.
> - *Forma del payload*: la doc muestra dos formas distintas; el servidor acepta ambas.

### Probar con ngrok

```bash
pnpm dev
ngrok http 3000
# Usa https://<subdominio>.ngrok-free.app/webhook/instagram como Callback URL en Meta
pnpm simulate:webhook --verify --url https://<subdominio>.ngrok-free.app/webhook/instagram
```

## Despliegue en Railway

El repo incluye un `Dockerfile`; Railway lo detecta y lo usa. Configura las variables de
`.env.example` en *Variables* del servicio y genera un dominio público (*Settings › Networking*):
esa es la URL HTTPS para el webhook. Railway inyecta `PORT`. (El volumen para SQLite se añade en la fase b.)

## Variables de entorno

Ver [`.env.example`](.env.example). Nunca subas secretos al repo: `.env` está en `.gitignore`.
