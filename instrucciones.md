# Paso a paso para poner en marcha el servicio

Guía práctica, en orden. Marca cada casilla al terminarla. Si algo no sale como dice aquí,
para y cuéntamelo con el mensaje de error o una captura.

> **¿Dónde se arranca el Docker?** En **Railway**, no en tu ordenador. Railway lee el `Dockerfile`
> del repositorio de GitHub, construye la imagen y la ejecuta en sus servidores cada vez que se
> sube un cambio al repo. **No necesitas instalar Docker.**

> **Qué tipo de conexión con Instagram usamos.** El panel de Meta ofrece ahora el **inicio de
> sesión unificado** (*API setup with Unified login*), que es el recomendado. El servicio está
> configurado para ese modo (`META_LOGIN=unified`). **No** uses la opción "inicio de sesión con
> Facebook": esa pide una Página de Facebook.

---

## 0. Cuentas que necesitas

- [ ] **Instagram** @humanidaddesdecero en modo profesional (*creator* vale) y **pública**.
- [ ] **Facebook**: tu cuenta personal vale; es con la que entras en el panel de desarrolladores.
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

## 2. Crea el proyecto en Railway y su URL (10 min)

Va primero porque Meta te pedirá una dirección HTTPS tuya.

- [ ] **2.1 Crea el proyecto.** En Railway: **New Project** → **Deploy from GitHub repo** →
  elige `GestionInstagram`.
  - Si no aparece, dale permiso a Railway sobre ese repositorio en GitHub.
  - Railway detecta el `Dockerfile` solo.
  - La rama que despliega es `claude/charming-rubin-owwaba`, que es la principal del repo.
- [ ] **2.2 El primer despliegue fallará, y es normal.** En los logs saldrá
  `Configuración inválida…` porque aún faltan las variables.
- [ ] **2.3 Añade un volumen** (aquí se guarda la base de datos; sin él se borra en cada
  despliegue): en el servicio, **+ New › Volume** (o clic derecho sobre el servicio → *Attach
  volume*) y pon de ruta de montaje (*Mount path*) **`/data`**.
- [ ] **2.4 Genera la URL pública.** **Settings › Networking › Generate Domain**. Si te pregunta
  el puerto, pon **3000**. Obtendrás algo como `https://gestioninstagram-production.up.railway.app`.
  Apúntala: la llamaremos **TU_DOMINIO**.

---

## 3. Configura la app de Meta (20–30 min)

Ya tienes la app creada con el caso de uso **"Administrar mensajes y contenido en Instagram"**.
Todo lo de este paso está en: menú izquierdo → **Casos de uso** → ese caso de uso → **Personalizar**
→ **API setup with Unified login**.

- [ ] **3.1 Crea la configuración** (sección *Configure your app* / *Configurar tu app*):
  - Pulsa **Create new configuration** (*Crear nueva configuración*).
    - Por defecto pide una cuenta de Instagram, una cuenta publicitaria (se puede saltar) y varios
      permisos.
    - Si te deja **editar los permisos**, quita los de anuncios (`ads_management`, `ads_read`) y
      publicación (`instagram_content_publish`).
    - **Imprescindibles**: `instagram_basic` e `instagram_manage_comments`. Meta exige además
      `instagram_manage_messages`; déjalo.
  - **Tipo de token**: si te deja elegir, **System-user access token** con caducidad **nunca**
    (*never expire*). Según la documentación de Meta, es lo que trae por defecto.
  - Pulsa **Use this configuration** (*Usar esta configuración*).
  - **Redirect URL** (*URL de redirección*): `https://TU_DOMINIO/auth/callback` → **Save**.
  - La "Login URL" que te muestre no hace falta.
- [ ] **3.2 Invita a tu Instagram como tester** (sección *Generate access tokens*):
  - Pulsa **Add account** e invita a @humanidaddesdecero como **Instagram Tester**.
  - **Acepta la invitación desde Instagram en el navegador** (no en la app del móvil):
    <https://www.instagram.com> → **Configuración** → **Permisos de sitios web** → **Apps y sitios
    web** → **Invitaciones de tester** → Aceptar.
  - Vuelve al panel de Meta: la cuenta aparece en la tabla.
- [ ] **3.3 Genera el token.**
  - Pulsa **Generate token** junto a tu cuenta y completa el login (con Instagram).
  - **Copia el token en ese momento: solo se muestra una vez** → `IG_ACCESS_TOKEN`.
  - Si lo pierdes, genera otro.
- [ ] **3.4 Saca tu IG_USER_ID.** Pega esta dirección en el navegador, cambiando `TU_TOKEN`:
  ```
  https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?fields=id,username&access_token=TU_TOKEN
  ```
  - Verás algo como `{"data":[{"id":"1784...","username":"humanidaddesdecero"}]}`.
  - El número de `id` → `IG_USER_ID`.
  - Si da error, el token no vale o no aceptaste la invitación: repite 3.2 y 3.3.
- [ ] **3.5 App ID y secret de Meta.** Menú izquierdo → **Configuración de la app** (⚙️) → **Básica**:
  - **Identificador de la app** → `IG_APP_ID`.
  - **Clave secreta de la app** (pulsa "Mostrar") → `IG_APP_SECRET`.

  Con el login unificado se usa el secret **de la app de Meta**, no el "Instagram app secret".

---

## 4. Variables en Railway y arranque (5 min)

- [ ] **4.1 Pega las variables.** En el servicio → **Variables** → *Raw Editor*, pega lo
  siguiente con tus valores:
  ```
  META_LOGIN=unified
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
- [ ] **4.2 Comprueba que vive.** Abre `https://TU_DOMINIO/health` en el navegador: debe salir
  `{"ok":true}`. En los logs de Railway verás `servicio listo`.
- [ ] **4.3 (Recomendado) Pon un límite de gasto** en *Usage* / *Billing* de Railway. La prueba da
  5 $ para 30 días; después, plan Hobby (5 $/mes).

---

## 5. Conecta el webhook de Meta (10 min)

- [ ] **5.1 Configura el webhook** (sección *Configure webhooks* de *API setup with Unified
  login*; si no está ahí, menú izquierdo → **Webhooks** → objeto **Instagram**):
  - **Callback URL**: `https://TU_DOMINIO/webhook/instagram`
  - **Verify token**: tu `WEBHOOK_VERIFY_TOKEN`
  - **Verify and save**. Si falla: el servidor no está en marcha (paso 4.2) o el verify token
    no coincide con la variable de Railway.
- [ ] **5.2 Suscribe solo `comments`.** En la lista de campos, deja suscrito **`comments`**. Los
  de mensajes puedes quitarlos.
- [ ] **5.3 Activa las notificaciones de tu cuenta.** Es una petición POST, así que no vale el
  navegador. Ábrela desde tu ordenador:
  - **Mac**: app *Terminal*.
  - **Windows**: *PowerShell*, y escribe `curl.exe` en vez de `curl`.
  ```bash
  curl -X POST "https://graph.facebook.com/v27.0/TU_IG_USER_ID/subscribed_apps?subscribed_fields=comments&access_token=TU_TOKEN"
  ```
  Debe responder `{"success":true}`.
- [ ] **5.4 Prueba del panel.** En el panel de webhooks de Meta, botón **Test** junto a
  `comments`. En Railway → *Deployments* → *View logs* debe aparecer `webhook recibido y
  encolado`.

  Si sale `firma X-Hub-Signature-256 inválida`, revisa que `IG_APP_SECRET` es la *Clave secreta
  de la app* del paso 3.5.

---

## 6. Primera prueba real (5 min)

- [ ] **6.1** Desde **otra** cuenta de Instagram, comenta en uno de tus vídeos.
- [ ] **6.2** En 1–2 minutos abre `https://TU_DOMINIO/review?token=TU_REPORT_TOKEN`. Debe aparecer
  el comentario con una respuesta propuesta. **Todavía no se publica nada.**
- [ ] **6.3 Si no llega nada**, mira los logs de Railway:
  - Si no aparece `webhook recibido`, Meta no está enviando los comentarios reales. Su
    documentación dice que eso puede requerir la app en modo *Live*.
  - Mientras lo resolvemos, activa el **plan B**: añade en Railway la variable
    `POLL_INTERVAL_SECONDS=60`. El servicio leerá tus comentarios nuevos cada minuto.
  - Avísame.

---

## 7. Prepara los comandos (`railway ssh`) (10 min)

Algunas tareas se hacen con comandos dentro del servidor de Railway.

- [ ] **7.1 Instala la CLI de Railway** en tu ordenador: <https://docs.railway.com/guides/cli>.
  - Mac: `brew install railway`.
  - Con Node instalado: `npm i -g @railway/cli`.
- [ ] **7.2 Conéctala al proyecto.** En la terminal:
  ```bash
  railway login
  railway link        # elige el proyecto y el servicio
  railway ssh         # abre una terminal DENTRO del servidor
  ```
  Dentro verás un prompt nuevo. Los comandos de los pasos 8 y 9 se escriben ahí. Si `railway ssh`
  no funciona en tu versión, avísame.

---

## 8. Fija la pregunta de cada vídeo (10 min)

- [ ] **8.1 Mira tus vídeos y la pregunta detectada:**
  ```bash
  pnpm question list --refresh
  ```
- [ ] **8.2 Corrige o completa las que falten**, con la URL del reel o con su número:
  ```bash
  pnpm question set https://www.instagram.com/reel/XXXXXXX/ "¿qué oficio quieres?"
  ```

---

## 9. Importa los comentarios que ya tienes (sin responderlos)

- [ ] **9.1 Prueba con un vídeo sin guardar nada.** Además sirve para comprobar que Claude
  entiende bien los comentarios:
  ```bash
  pnpm import:comments --dry-run --media https://www.instagram.com/reel/XXXXXXX/
  ```
  **Cópiame la salida** si algo está mal y ajusto el prompt.
- [ ] **9.2 Importa todo.** Con `REVIEW_MODE=true`, como está:
  ```bash
  pnpm import:comments
  ```
  No responde a nadie: solo analiza y guarda.
- [ ] **9.3 Mira los informes en el móvil** (guárdalos en favoritos):
  - Vídeos: `https://TU_DOMINIO/report?token=TU_REPORT_TOKEN`
  - Participantes: `https://TU_DOMINIO/participants?token=TU_REPORT_TOKEN`
  - En cada uno hay un enlace **CSV** para abrirlo en Excel o Google Sheets.

---

## 10. Tres días en modo revisión

- [ ] **10.1** Varias veces al día, abre `https://TU_DOMINIO/review?token=TU_REPORT_TOKEN`:
  - **Aprobar**: se publica en 1–5 min (con el texto editado, si lo has cambiado).
  - **Rechazar**: no se publica.
  - **Aprobar todas**: si todas te valen.
  - **Rehacer**: vuelve a generar la respuesta con el prompt actual (p. ej. tras cambiarlo); en unos
    segundos aparece otra vez para revisarla. El botón azul de arriba rehace todas las pendientes.
- [ ] **10.2 Ve apuntando** las respuestas que no te gusten. Con eso ajustamos `prompts/reply.md`.

---

## 11. Pasar a automático

- [ ] **11.1** Cuando te fíes, cambia en Railway la variable `REVIEW_MODE` a `false`. Desde ese
  momento las respuestas se publican solas: con su delay de 1–5 min y como mucho 60 por hora.
- [ ] **11.2** Para volver a revisar a mano, pon otra vez `REVIEW_MODE=true`.

---

## Mantenimiento

- **Cambiar cómo respondes**: edita `prompts/reply.md` en GitHub (botón del lápiz) y guarda.
  Railway redespliega solo.
- **Votaciones con me gusta**: publica en el vídeo un comentario por candidato u opción y pide que
  voten dándole me gusta. En el informe del vídeo, el enlace **votos (me gusta)** los cuenta en ese
  momento y dice quién va ganando (pulsa *Actualizar* para volver a contar).
- **Palabras que no quieres responder**: `config/blocked.txt`.
- **Frases de spam**: `config/spam.txt`.
- **Token**: con el login unificado no caduca por defecto (lo verás en la vista previa de la
  configuración en Meta). Deja de valer si quitas la app de tu portfolio comercial o mueves la
  cuenta de Instagram a otro portfolio: entonces genera otro (paso 3.3) y cámbialo en
  `IG_ACCESS_TOKEN`.
- **Estado del servicio**: `https://TU_DOMINIO/status?token=TU_REPORT_TOKEN`.
- **Comentarios que fallaron**: `pnpm review stats` para verlos y `pnpm review retry <id>` para
  reintentar.

## Problemas frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Logs: `Configuración inválida` | Falta una variable o tiene mal formato | Revisa la lista del paso 4.1 |
| `/health` no carga | El servicio no ha arrancado | Mira los logs del último despliegue |
| No aparece *API setup with Unified login* | La app no pertenece a un portfolio comercial | Conéctala en *Configuración de la app › Básica* y avísame |
| La URL del paso 3.4 da error | Token mal copiado o invitación de tester sin aceptar | Repite 3.2 y 3.3 |
| Meta no verifica el webhook | Servidor caído o verify token distinto | Pasos 4.2 y 5.1 |
| Logs: `firma … inválida` (401) | Secret equivocado | Usa la *Clave secreta de la app* (paso 3.5) |
| El *Test* llega pero los comentarios reales no | Meta puede exigir la app en modo Live | Plan B (`POLL_INTERVAL_SECONDS=60`) y avísame |
| Tras un despliegue, los informes salen vacíos | El volumen no está en `/data` | Paso 2.3 |
| Logs: `Invalid OAuth access token` | El token ya no vale | Genera otro (paso 3.3) y actualiza `IG_ACCESS_TOKEN` |
