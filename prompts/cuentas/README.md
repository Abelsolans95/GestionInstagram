# Prompts de cada cuenta

La cuenta **principal** (la primera de `IG_USER_ID`) usa los prompts de `prompts/`.

Cada **otra cuenta** usa SOLO los de su carpeta, `prompts/cuentas/<usuario>/`, con su @ de
Instagram en minúscula y sin la @ (también vale una carpeta con su ID, `prompts/cuentas/1784…/`):

| Fichero | ¿Hace falta? | Para qué |
|---|---|---|
| `reply.md` | **Sí** | Cómo respondes en esa cuenta. Sin él no se publica nada: los comentarios quedan como fallidos hasta que lo añadas (luego, *Reintentar* en `/review`). |
| `question.md` | No | Sacar del caption la pregunta del vídeo. |
| `extract.md` | No | Analizar las respuestas a la pregunta (informes). Sin él, en esa cuenta solo se responde. |
| `historia.md` | No | Lo que ya existe o ha pasado en la cuenta, si va contando una historia. |

Para empezar una cuenta nueva, copia `_plantilla/` a `prompts/cuentas/<usuario>/` y rellena lo que
va entre corchetes. El tono es el mismo que el de la cuenta principal.

`reply.md` tiene que pedir siempre la salida en JSON con estos tres campos (el servicio lo exige):
`{"reply": string|null, "reason": string, "complaint": boolean}`.
