# Paso a paso para poner en marcha el servicio

Guía práctica, en orden. Marca cada casilla al terminarla. Si algo no sale como dice aquí,
para y cuéntamelo con el mensaje de error.

> **¿Dónde se arranca el Docker?** En **Railway**, no en tu ordenador. Railway lee el `Dockerfile`
> del repositorio de GitHub, construye la imagen y la ejecuta en sus servidores cada vez que se
> sube un cambio al repo. **No necesitas instalar Docker.**

---

## 0. Cuentas que necesitas

- [ ] **Instagram** @humanidaddesdecero en modo profesional (*creator* vale) y **pública**.
- [ ] **Facebook**: cualquier cuenta personal; solo sirve para entrar como desarrollador en Meta.
- [ ] **GitHub**: ya la tienes; el código está en `Abelsolans95/GestionInstagram`.
- [ ] **Railway**: <https://railway.com>; entra con tu cuenta de GitHub.
- [ ] **Anthropic** (Claude): <https://console.anthropic.com>.

---

## 1. Prepara tus claves (10 min)

Vas a ir rellenando esta lista. Guárdala en un sitio privado (gestor de contraseñas o nota
privada), **nunca** en el repositorio ni en un chat.

```
IG_APP_ID=
IG_APP_SECRET=
IG_ACCESS_TOKEN=
IG_USER_ID=
WEBHOOK_VERIFY_TOKEN=
ANTHROPIC_API_KEY=
REPORT_TOKEN=
```

- [ ] **ANTHROPIC_API_KEY**: en la consola de Anthropic crea una API key y añade algo de crédito
  (con 5 $ tienes para mucho tiempo).
- [ ] **WEBHOOK_VERIFY_TOKEN**: invéntalo tú, por ejemplo `humanidad-webhook-8f3k2p`. Lo pegarás
  también en Meta.
- [ ] **REPORT_TOKEN**: la "contraseña" de los informes y de la página de revisión. Que sea larga
  (16 caracteres o más) y aleatoria. Puedes generarla con un gestor de contraseñas, o en la
  terminal con `openssl rand -hex 20`.

---

## 2. Crea la app en Meta (20–30 min)

- [ ] **2.1 Regístrate como desarrollador.** Con la sesión de Facebook abierta, entra en
  <https://developers.facebook.com/async/registration> y confirma el teléfono y el email.
- [ ] **2.2 Crea la app.** Entra en <https://developers.facebook.com/apps> → **Create App**.
  - Caso de uso: **Other**.
  - Tipo: **Business**.
  - Pon un nombre (p. ej. "Humanidad comentarios") y tu email.
- [ ] **2.3 Añade el producto Instagram.** En el panel de la app, busca **Instagram** → **Set up**.
  Se crea la sección **API setup with Instagram login**.
- [ ] **2.4 Copia el App ID y el secret.** Están en *Instagram › API setup with Instagram login
  › 3. Set up Instagram business login › Business login settings*:
  - **Instagram App ID** → `IG_APP_ID`
  - **Instagram app secret** → `IG_APP_SECRET`

  Ojo: es el secret de *Instagram*, no el "App secret" de *App settings › Basic*.
- [ ] **2.5 Genera el token.** En *API setup with Instagram login* → **Generate access tokens**
  → **Add account**.
  - Inicia sesión con @humanidaddesdecero y acepta los permisos (`instagram_business_basic` e
    `instagram_business_manage_comments`).
  - Copia el token → `IG_ACCESS_TOKEN`.
- [ ] **2.6 Saca tu IG_USER_ID.** Pega esta dirección en el navegador, cambiando `TU_TOKEN`:
  ```
  https://graph.instagram.com/v27.0/me?fields=user_id,username&access_token=TU_TOKEN
  ```
  Verás algo como `{"user_id":"1784...","username":"humanidaddesdecero"}`. El número de
  `user_id` → `IG_USER_ID`.

  Si da error, el token no vale: repite el paso 2.5.

> Todavía no configures el webhook: primero hace falta que el servidor esté funcionando (paso 3).

---

## 3. Despliega en Railway (15 min)

- [ ] **3.1 Crea el proyecto.** En Railway: **New Project** → **Deploy from GitHub repo** →
  elige `GestionInstagram`.
  - Si no aparece, dale permiso a Railway sobre ese repositorio en GitHub.
  - Railway detecta el `Dockerfile` solo.
  - La rama que despliega es `claude/charming-rubin-owwaba`, que ahora mismo es la única y la
    principal del repo.
- [ ] **3.2 El primer despliegue fallará, y es normal.** En los logs saldrá
  `Configuración inválida… IG_APP_SECRET…` porque aún faltan las variables.
- [ ] **3.3 Añade un volumen** (aquí se guarda la base de datos; sin él se borra en cada
  despliegue): en el servicio, **+ New › Volume** (o clic derecho sobre el servicio → *Attach
  volume*) y pon de ruta de montaje (*Mount path*) **`/data`**.
- [ ] **3.4 Añade las variables.** En el servicio → pestaña **Variables** → *Raw Editor*, pega lo
  siguiente con tus valores:
  ```
  IG_APP_ID=...
  IG_APP_SECRET=...
  IG_ACCESS_TOKEN=...
  IG_USER_ID=...
  WEBHOOK_VERIFY_TOKEN=...
  ANTHROPIC_API_KEY=...
  REPORT_TOKEN=...
  REVIEW_MODE=true
  REPLY_DELAY_MIN=60
  REPLY_DELAY_MAX=300
  MAX_REPLIES_PER_HOUR=60
  PORT=3000
  ```
  Guarda. Railway vuelve a desplegar solo.
- [ ] **3.5 Genera la URL pública.** **Settings › Networking › Generate Domain**. Si te pregunta
  el puerto, pon **3000**. Obtendrás algo como `https://gestioninstagram-production.up.railway.app`.
  Apúntala: la llamaremos **TU_DOMINIO**.
- [ ] **3.6 Comprueba que vive.** Abre `https://TU_DOMINIO/health` en el navegador: debe salir
  `{"ok":true}`.
- [ ] **3.7 (Recomendado) Pon un límite de gasto.** En *Usage* / *Billing* de Railway. La prueba
  da 5 $ para 30 días; después, plan Hobby (5 $/mes).

---

## 4. Conecta el webhook de Meta (10 min)

- [ ] **4.1 Configura el webhook.** En Meta: *Instagram › API setup with Instagram login* →
  **Configure webhooks**.
  - **Callback URL**: `https://TU_DOMINIO/webhook/instagram`
  - **Verify token**: tu `WEBHOOK_VERIFY_TOKEN`
  - **Verify and save**. Si falla: el servidor no está en marcha (paso 3.6) o el verify token
    no coincide con la variable de Railway.
- [ ] **4.2 Suscribe solo `comments`.** En la lista de campos del webhook, deja suscrito
  **`comments`**. Los de mensajes (`messages`, …) puedes quitarlos.
- [ ] **4.3 Activa las notificaciones de tu cuenta.** Es una petición POST, así que no vale el
  navegador. Ábrela desde tu ordenador:
  - **Mac**: app *Terminal*.
  - **Windows**: *PowerShell*, y escribe `curl.exe` en vez de `curl`.
  ```bash
  curl -X POST "https://graph.instagram.com/v27.0/TU_IG_USER_ID/subscribed_apps?subscribed_fields=comments&access_token=TU_TOKEN"
  ```
  Debe responder `{"success":true}`.
- [ ] **4.4 Prueba del panel.** En el panel de webhooks de Meta, botón **Test** junto a
  `comments`. En Railway → *Deployments* → *View logs* debe aparecer `webhook recibido y
  encolado`.

  Si sale `firma X-Hub-Signature-256 inválida`, cambia `IG_APP_SECRET` por el *App secret* de
  *App settings › Basic* y prueba otra vez.

---

## 5. Primera prueba real (5 min)

- [ ] **5.1** Desde **otra** cuenta de Instagram, comenta en uno de tus vídeos.
- [ ] **5.2** En 1–2 minutos abre `https://TU_DOMINIO/review?token=TU_REPORT_TOKEN`. Debe aparecer
  el comentario con una respuesta propuesta. **Todavía no se publica nada.**
- [ ] **5.3 Si no llega nada**, mira los logs de Railway:
  - Si no aparece `webhook recibido`, Meta no está enviando los comentarios reales. Seguramente
    pide la app en modo *Live*.
  - Mientras lo resolvemos, activa el **plan B**: añade en Railway la variable
    `POLL_INTERVAL_SECONDS=60`. El servicio leerá tus comentarios nuevos cada minuto.
  - Avísame y vemos lo de pasar la app a Live.

---

## 6. Prepara los comandos (`railway ssh`) (10 min)

Algunas tareas se hacen con comandos dentro del servidor de Railway.

- [ ] **6.1 Instala la CLI de Railway** en tu ordenador: <https://docs.railway.com/guides/cli>.
  - Mac: `brew install railway`.
  - Con Node instalado: `npm i -g @railway/cli`.
- [ ] **6.2 Conéctala al proyecto.** En la terminal:
  ```bash
  railway login
  railway link        # elige el proyecto y el servicio
  railway ssh         # abre una terminal DENTRO del servidor
  ```
  Dentro verás un prompt nuevo. Los comandos de los pasos 7 y 8 se escriben ahí. Si `railway ssh`
  no funciona en tu versión, avísame.

---

## 7. Fija la pregunta de cada vídeo (10 min)

- [ ] **7.1 Mira tus vídeos y la pregunta detectada:**
  ```bash
  pnpm question list --refresh
  ```
  Muestra tus vídeos y la pregunta que ha sacado del caption (o *sin pregunta*).
- [ ] **7.2 Corrige o completa las que falten**, con la URL del reel o con su número:
  ```bash
  pnpm question set https://www.instagram.com/reel/XXXXXXX/ "¿qué oficio quieres?"
  ```
  Repite con cada vídeo cuya pregunta solo se diga en el propio vídeo.

---

## 8. Importa los comentarios que ya tienes (sin responderlos)

- [ ] **8.1 Prueba con un vídeo sin guardar nada.** Además sirve para comprobar que Claude
  entiende bien los comentarios:
  ```bash
  pnpm import:comments --dry-run --media https://www.instagram.com/reel/XXXXXXX/
  ```
  Verás cada comentario con lo que ha entendido (p. ej. `→ herrero`, `personaje: Dyland`).
  **Si algo está mal, cópiame esa salida** y ajusto el prompt.
- [ ] **8.2 Importa todo.** Con `REVIEW_MODE=true`, como está:
  ```bash
  pnpm import:comments
  ```
  No responde a nadie: solo analiza y guarda.
- [ ] **8.3 Mira los informes en el móvil** (guárdalos en favoritos):
  - Vídeos: `https://TU_DOMINIO/report?token=TU_REPORT_TOKEN`
  - Participantes: `https://TU_DOMINIO/participants?token=TU_REPORT_TOKEN`
  - En cada informe hay un enlace **CSV** para abrirlo en Excel o Google Sheets.

---

## 9. Tres días en modo revisión

- [ ] **9.1** Varias veces al día, abre `https://TU_DOMINIO/review?token=TU_REPORT_TOKEN`:
  - **Aprobar**: se publica en 1–5 min (con el texto editado, si lo has cambiado).
  - **Rechazar**: no se publica.
  - **Aprobar todas**: si todas te valen.
- [ ] **9.2 Ve apuntando** las respuestas que no te gusten (tono, emojis, cosas que nunca dirías).
  Con eso ajustamos `prompts/reply.md`.

---

## 10. Pasar a automático

- [ ] **10.1** Cuando te fíes, cambia en Railway la variable `REVIEW_MODE` a `false`. Railway
  redespliega y desde ese momento las respuestas se publican solas: con su delay de 1–5 min y
  como mucho 60 por hora.
- [ ] **10.2** Si quieres volver a revisar a mano, pon otra vez `REVIEW_MODE=true`.

---

## Mantenimiento

- **Cambiar cómo respondes**: edita `prompts/reply.md` en GitHub (botón del lápiz) y guarda.
  Railway redespliega solo.
- **Palabras que no quieres responder**: `config/blocked.txt`.
- **Frases de spam**: `config/spam.txt`.
- **Token de Instagram**: se renueva solo cada 7 días.
  - Para comprobarlo: `pnpm token status` (en `railway ssh`).
  - Si el servicio pasa más de 60 días apagado, el token caduca: genera uno nuevo (paso 2.5) y
    cámbialo en la variable `IG_ACCESS_TOKEN`.
- **Estado del servicio**: `https://TU_DOMINIO/status?token=TU_REPORT_TOKEN`.
- **Comentarios que fallaron**: `pnpm review stats` para verlos y `pnpm review retry <id>` para
  reintentar.

## Problemas frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Logs: `Configuración inválida` | Falta una variable o tiene mal formato | Revisa la lista del paso 3.4 |
| `/health` no carga | El servicio no ha arrancado | Mira los logs del último despliegue |
| Meta no verifica el webhook | Servidor caído o verify token distinto | Pasos 3.6 y 4.1 |
| Logs: `firma … inválida` (401) | Secret equivocado | Prueba el *App secret* de *App settings › Basic* |
| El *Test* llega pero los comentarios reales no | La app de Meta tiene que estar en Live | Plan B (`POLL_INTERVAL_SECONDS=60`) y avísame |
| Tras un despliegue, los informes salen vacíos | El volumen no está en `/data` | Paso 3.3 |
| Logs: `Invalid OAuth access token` | Token caducado o mal copiado | Genera otro (paso 2.5) y actualiza `IG_ACCESS_TOKEN` |
