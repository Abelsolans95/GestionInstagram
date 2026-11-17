# Vigía del sorteo de la PS5

Script aparte (no forma parte del servicio de Railway) que cada ~15 minutos mira los comentarios
del reel del sorteo y te avisa por correo y/o al móvil:

- 🚨 **Urgente**: si a uno de tus comentarios le dan un "me gusta" → toca comentar otra vez.
- ⚠️ Si ya no te queda ningún comentario sin "me gusta".
- Cuántos comentarios de otros siguen sin ningún "me gusta" (solo si el número cambia, para no
  llenarte el correo; con `AVISAR_SIEMPRE=1` te avisa en cada vuelta).

**Solo lee.** Nunca comenta ni da "me gusta": los comentarios los publicas tú desde la app.

> Usa una API no oficial (instagrapi), que incumple las condiciones de Instagram. Por eso entra con
> una **cuenta secundaria**, nunca con @humanidaddesdecero. Lo peor que puede pasar es que
> Instagram le pida verificación o la bloquee a ella.

## Puesta en marcha (en tu ordenador)

1. **Cuenta secundaria**: crea una en la app (Añadir cuenta) con otro correo. Ábrela y úsala un
   poco desde el móvil antes; las cuentas recién creadas son las que más se bloquean.
2. **Contraseña de aplicación de Gmail** (para que el script te pueda mandar correos):
   Cuenta de Google → Seguridad → activa la verificación en dos pasos → busca
   "Contraseñas de aplicaciones" → crea una llamada "vigía". Son 16 letras.
3. **(Opcional) Avisos al móvil**: instala la app gratuita **ntfy**, pulsa "+" y suscríbete a un
   nombre largo inventado (p. ej. `ps5-abel-x7k29q`). Pon ese mismo nombre en `NTFY_TEMA`.
4. Instala Python 3.10 o superior y, en esta carpeta:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate        # en Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   cp .env.example .env             # en Windows: copy .env.example .env
   ```

5. Rellena `.env` (usuario y contraseña de la cuenta secundaria, la cuenta desde la que comentas
   en `MIS_CUENTAS`, y el Gmail).
6. Prueba los avisos: `python vigia_sorteo.py --prueba-aviso`
7. Prueba una vuelta: `python vigia_sorteo.py --una-vez`
   (la primera vez puede pedirte el código de verificación en la terminal).
8. Déjalo vigilando: `python vigia_sorteo.py` (Ctrl+C para parar). El ordenador tiene que estar
   encendido y sin suspenderse.

## Archivos que crea (no se suben a git)

- `sesion.json`: la sesión de Instagram, para no iniciar sesión en cada vuelta (eso sí que levanta
  sospechas). No lo compartas: da acceso a la cuenta secundaria.
- `estado.json`: los "me gusta" de la vuelta anterior, para saber qué ha cambiado.

## Pruebas

```bash
python -m unittest test_vigia_sorteo
```
