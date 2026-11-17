"""Vigía del sorteo: vigila TUS comentarios en un reel ajeno y te avisa si les dan "me gusta".

Pensado para reels con miles de comentarios sin gastar apenas peticiones:

- Cada ~15 min (vuelta rápida):
    · pregunta a Instagram quién ha dado "me gusta" a cada uno de tus comentarios (1 petición
      por comentario) → si alguno pasa de 0 a 1+, aviso URGENTE para que comentes otra vez;
    · lee solo las primeras páginas de comentarios (~100) para encontrar tus comentarios nuevos.
- Cada BARRIDO_HORAS (barrido completo): lee todos los comentarios (con 12.000 son ~600
  peticiones, ~20 min) para contar cuántos siguen sin "me gusta" y encontrar tus comentarios
  que la vuelta rápida no haya visto.

Solo LEE. Nunca comenta, ni da "me gusta", ni sigue a nadie. Los comentarios del sorteo los
publicas tú a mano desde la app.

Uso:
    python vigia_sorteo.py                 # bucle infinito (Ctrl+C para parar)
    python vigia_sorteo.py --una-vez       # una sola vuelta
    python vigia_sorteo.py --barrido       # fuerza un barrido completo en la primera vuelta
    python vigia_sorteo.py --prueba-aviso  # envía un aviso de prueba y sale
"""

from __future__ import annotations

import json
import os
import random
import smtplib
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

CARPETA = Path(__file__).resolve().parent
ARCHIVO_SESION = CARPETA / "sesion.json"
ARCHIVO_ESTADO = CARPETA / "estado.json"


# --------------------------------------------------------------------------- configuración


def cargar_env(ruta: Path) -> None:
    """Lee un .env sencillo (CLAVE=valor). Las variables ya definidas tienen prioridad."""
    if not ruta.exists():
        return
    for linea in ruta.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, valor = linea.split("=", 1)
        valor = valor.strip().strip('"').strip("'")
        os.environ.setdefault(clave.strip(), valor)


def _num(valor: str | None, defecto: float) -> float:
    try:
        return float(valor) if valor not in (None, "") else defecto
    except ValueError:
        sys.exit(f"Valor numérico no válido en .env: {valor!r}")


@dataclass
class Config:
    ig_usuario: str
    ig_password: str
    reel_url: str
    mis_cuentas: set[str]
    intervalo_min: float = 15
    barrido_horas: float = 12
    recientes: int = 100
    avisar_siempre: bool = False
    gmail_usuario: str = ""
    gmail_app_password: str = ""
    avisar_a: str = ""
    ntfy_tema: str = ""

    @classmethod
    def desde_entorno(cls) -> "Config":
        e = os.environ.get
        faltan = [k for k in ("IG_USUARIO", "IG_PASSWORD", "REEL_URL", "MIS_CUENTAS") if not e(k)]
        if faltan:
            sys.exit(f"Faltan variables en .env: {', '.join(faltan)}")
        cfg = cls(
            ig_usuario=e("IG_USUARIO", "").strip().lstrip("@"),
            ig_password=e("IG_PASSWORD", ""),
            reel_url=e("REEL_URL", "").strip(),
            mis_cuentas={c.strip().lstrip("@").lower() for c in e("MIS_CUENTAS", "").split(",") if c.strip()},
            intervalo_min=max(5.0, _num(e("INTERVALO_MIN"), 15)),
            barrido_horas=max(0.0, _num(e("BARRIDO_HORAS"), 12)),
            recientes=max(0, int(_num(e("COMENTARIOS_RECIENTES"), 100))),
            avisar_siempre=e("AVISAR_SIEMPRE", "0").strip().lower() in ("1", "true", "si", "sí"),
            gmail_usuario=e("GMAIL_USUARIO", "").strip(),
            gmail_app_password=e("GMAIL_APP_PASSWORD", "").replace(" ", ""),
            avisar_a=(e("AVISAR_A", "") or e("GMAIL_USUARIO", "")).strip(),
            ntfy_tema=e("NTFY_TEMA", "").strip(),
        )
        if not (cfg.gmail_usuario and cfg.gmail_app_password) and not cfg.ntfy_tema:
            sys.exit("Configura al menos un aviso: GMAIL_USUARIO + GMAIL_APP_PASSWORD, o NTFY_TEMA.")
        return cfg


# --------------------------------------------------------------------------- lógica (pura)


@dataclass
class Comentario:
    pk: str
    usuario: str
    texto: str
    likes: int


@dataclass
class Resultado:
    mios: list[Comentario]  # tus comentarios vigilados, con los likes actuales
    nuevos_likes: list[Comentario]  # tenían 0 y ahora tienen alguno (o aparecen ya con likes)
    descubiertos: list[Comentario]  # tuyos que se vigilan desde esta vuelta
    desaparecidos: list[Comentario]  # tuyos que Instagram ya no encuentra
    primera_vez: bool
    barrido: dict | None  # {"total", "otros_sin_likes", "ejemplos"} si en esta vuelta hubo barrido
    estado: dict = field(default_factory=dict)

    @property
    def urgente(self) -> bool:
        return bool(self.nuevos_likes)

    @property
    def mios_sin_likes(self) -> list[Comentario]:
        return [c for c in self.mios if c.likes == 0]


def es_mio(c: Comentario, mis_cuentas: set[str]) -> bool:
    return c.usuario.lower() in mis_cuentas


def procesar(
    estado_previo: dict,
    leidos: list[Comentario],
    likes_consultados: dict[str, int | None],
    mis_cuentas: set[str],
    es_barrido: bool,
    ahora: float,
) -> Resultado:
    """Combina lo leído en esta vuelta con el estado anterior.

    leidos: comentarios leídos del reel (las primeras páginas, o todos si es barrido).
    likes_consultados: pk → likes de tus comentarios ya conocidos que no venían en `leidos`
        (None = Instagram ya no lo encuentra).
    """
    previos: dict[str, dict] = estado_previo.get("mios", {})
    primera_vez = not estado_previo
    vistos = {c.pk: c for c in leidos if es_mio(c, mis_cuentas)}

    mios: list[Comentario] = []
    nuevos_likes: list[Comentario] = []
    descubiertos: list[Comentario] = []
    desaparecidos: list[Comentario] = []

    for pk, info in previos.items():
        antes = Comentario(pk, info["usuario"], info["texto"], int(info["likes"]))
        if pk in vistos:
            likes = vistos[pk].likes
        elif pk in likes_consultados:
            likes = likes_consultados[pk]
        else:
            likes = antes.likes  # no se pudo consultar: se queda como estaba
        if likes is None:
            desaparecidos.append(antes)
            continue
        actual = Comentario(pk, antes.usuario, antes.texto, likes)
        mios.append(actual)
        if antes.likes == 0 and likes > 0:
            nuevos_likes.append(actual)

    for pk, c in vistos.items():
        if pk in previos:
            continue
        mios.append(c)
        descubiertos.append(c)
        if c.likes > 0 and not primera_vez:
            nuevos_likes.append(c)  # lo publicaste y le dieron like antes de que lo viéramos

    barrido = None
    if es_barrido:
        otros = [c for c in leidos if not es_mio(c, mis_cuentas) and c.likes == 0]
        barrido = {
            "total": len(leidos),
            "otros_sin_likes": len(otros),
            "ejemplos": [[c.usuario, c.texto] for c in otros[:5]],
            "cuando": ahora,
        }

    estado = {
        "mios": {c.pk: {"usuario": c.usuario, "texto": c.texto, "likes": c.likes} for c in mios},
        "barrido": barrido or estado_previo.get("barrido"),
    }
    return Resultado(mios, nuevos_likes, descubiertos, desaparecidos, primera_vez, barrido, estado)


def toca_barrido(estado: dict, barrido_horas: float, ahora: float) -> bool:
    ultimo = (estado.get("barrido") or {}).get("cuando")
    if ultimo is None:
        return True  # nunca se ha hecho: hace falta para encontrar tus comentarios antiguos
    return barrido_horas > 0 and ahora - ultimo >= barrido_horas * 3600


def hay_que_avisar(r: Resultado, avisar_siempre: bool) -> bool:
    return bool(
        avisar_siempre or r.primera_vez or r.urgente or r.desaparecidos or r.descubiertos or r.barrido
    )


def _recorta(texto: str, n: int = 60) -> str:
    texto = " ".join(texto.split())
    return texto if len(texto) <= n else texto[: n - 1] + "…"


def redactar(r: Resultado, reel_url: str, ahora: float) -> tuple[str, str]:
    sin = len(r.mios_sin_likes)
    if r.urgente:
        asunto = f"🚨 Sorteo PS5: te han dado like en {len(r.nuevos_likes)} comentario(s). ¡Comenta otra vez!"
    elif r.mios and not sin:
        asunto = "⚠️ Sorteo PS5: no te queda ningún comentario sin likes"
    elif r.descubiertos and not r.primera_vez:
        asunto = f"👀 Sorteo PS5: ya vigilo tu comentario nuevo · tú: {sin} sin likes"
    elif r.barrido:
        asunto = f"Sorteo PS5: {r.barrido['otros_sin_likes']} comentarios de otros sin likes · tú: {sin} sin likes"
    else:
        asunto = f"Sorteo PS5: sin cambios · tú: {sin} sin likes"

    lineas = [f"Comprobado: {datetime.fromtimestamp(ahora):%d/%m %H:%M}", f"Reel: {reel_url}", ""]
    for c in r.nuevos_likes:
        lineas.append(f"❤️ Le han dado like a tu comentario «{_recorta(c.texto)}» ({c.likes} likes)")
    for c in r.desaparecidos:
        lineas.append(f"❓ Tu comentario «{_recorta(c.texto)}» ya no aparece (¿ocultado o borrado?)")
    if r.nuevos_likes or r.desaparecidos:
        lineas.append("")

    if r.mios:
        lineas.append(f"Tus comentarios: {len(r.mios)} (sin likes: {sin})")
        for c in r.mios:
            marca = "✅ 0 likes" if c.likes == 0 else f"❌ {c.likes} likes"
            lineas.append(f"  · @{c.usuario}: «{_recorta(c.texto)}» → {marca}")
    else:
        lineas.append(
            "Tus comentarios: no encuentro ninguno. Si acabas de comentar, aparecerá en la próxima"
            " vuelta o en el próximo barrido. Revisa también MIS_CUENTAS."
        )

    b = r.barrido or r.estado.get("barrido")
    if b:
        hace = (ahora - b["cuando"]) / 3600
        cuando = "ahora" if hace < 0.1 else f"hace {hace:.0f} h"
        lineas.append("")
        lineas.append(f"Último recuento completo ({cuando}): {b['total']} comentarios,")
        lineas.append(f"  {b['otros_sin_likes']} de otros sin ningún like. Algunos:")
        for usuario, texto in b["ejemplos"]:
            lineas.append(f"  · @{usuario}: «{_recorta(texto)}»")
    return asunto, "\n".join(lineas)


# --------------------------------------------------------------------------- avisos


def log(texto: str) -> None:
    print(f"[{datetime.now():%d/%m %H:%M:%S}] {texto}", flush=True)


def enviar_aviso(cfg: Config, asunto: str, cuerpo: str, urgente: bool) -> None:
    errores = []
    if cfg.gmail_usuario and cfg.gmail_app_password:
        try:
            msg = EmailMessage()
            msg["Subject"] = asunto
            msg["From"] = cfg.gmail_usuario
            msg["To"] = cfg.avisar_a
            msg.set_content(cuerpo)
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
                s.login(cfg.gmail_usuario, cfg.gmail_app_password)
                s.send_message(msg)
        except Exception as ex:  # noqa: BLE001 — que un fallo del correo no pare el vigía
            errores.append(f"correo: {ex}")
    if cfg.ntfy_tema:
        try:
            datos = json.dumps(
                {
                    "topic": cfg.ntfy_tema,
                    "title": asunto,
                    "message": cuerpo,
                    "priority": 5 if urgente else 3,
                    "click": cfg.reel_url,
                }
            ).encode("utf-8")
            req = urllib.request.Request(
                "https://ntfy.sh/", data=datos, headers={"Content-Type": "application/json"}
            )
            urllib.request.urlopen(req, timeout=30).read()
        except Exception as ex:  # noqa: BLE001
            errores.append(f"ntfy: {ex}")
    if errores:
        log("No se pudo enviar el aviso → " + " | ".join(errores))
    else:
        log(f"Aviso enviado: {asunto}")


# --------------------------------------------------------------------------- Instagram


def conectar(cfg: Config):
    from instagrapi import Client
    from instagrapi.exceptions import LoginRequired, TwoFactorRequired

    cl = Client()
    cl.delay_range = [1, 3]  # pausa aleatoria antes de cada petición
    if ARCHIVO_SESION.exists():
        cl.load_settings(ARCHIVO_SESION)
        try:
            cl.login(cfg.ig_usuario, cfg.ig_password)
            cl.get_timeline_feed()  # comprueba que la sesión sigue viva
            log(f"Sesión reutilizada (@{cfg.ig_usuario})")
            return cl
        except LoginRequired:
            log("La sesión guardada caducó; vuelvo a iniciar sesión")
            uuids = cl.get_settings()["uuids"]
            cl.set_settings({})
            cl.set_uuids(uuids)  # mismo "dispositivo" para no parecer un móvil nuevo
    try:
        cl.login(cfg.ig_usuario, cfg.ig_password)
    except TwoFactorRequired:
        codigo = input("Instagram pide el código de verificación en dos pasos: ").strip()
        cl.login(cfg.ig_usuario, cfg.ig_password, verification_code=codigo)
    cl.dump_settings(ARCHIVO_SESION)
    log(f"Sesión iniciada (@{cfg.ig_usuario})")
    return cl


def leer_comentarios(cl, media_id: str, cuantos: int) -> list[Comentario]:
    """cuantos=0 → todos (barrido completo)."""
    return [
        Comentario(pk=str(c.pk), usuario=c.user.username, texto=c.text or "", likes=int(c.like_count or 0))
        for c in cl.media_comments(media_id, amount=cuantos)
    ]


def contar_likes(cl, comment_pk: str) -> int | None:
    """Likes de un comentario (None si Instagram ya no lo encuentra)."""
    from instagrapi.exceptions import ClientError, ClientNotFoundError

    try:
        return len(cl.comment_likers(comment_pk))
    except ClientNotFoundError:
        return None
    except ClientError as ex:
        if "not found" in str(ex).lower() or "no encontrado" in str(ex).lower():
            return None
        raise


def cargar_estado() -> dict:
    try:
        estado = json.loads(ARCHIVO_ESTADO.read_text(encoding="utf-8"))
        return estado if isinstance(estado, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def guardar_estado(estado: dict) -> None:
    ARCHIVO_ESTADO.write_text(json.dumps(estado, ensure_ascii=False, indent=2), encoding="utf-8")


def una_vuelta(cfg: Config, cl, media_id: str, forzar_barrido: bool = False) -> None:
    previo = cargar_estado()
    ahora = time.time()
    es_barrido = forzar_barrido or toca_barrido(previo, cfg.barrido_horas, ahora)

    if es_barrido:
        log("Barrido completo: leo todos los comentarios (con miles puede tardar ~20 min)")
        leidos = leer_comentarios(cl, media_id, 0)
    else:
        leidos = leer_comentarios(cl, media_id, cfg.recientes) if cfg.recientes else []

    en_leidos = {c.pk for c in leidos}
    likes = {pk: contar_likes(cl, pk) for pk in previo.get("mios", {}) if pk not in en_leidos}

    r = procesar(previo, leidos, likes, cfg.mis_cuentas, es_barrido, time.time())
    log(
        f"{'Barrido' if es_barrido else 'Vuelta'}: {len(leidos)} leídos · tuyos {len(r.mios)} "
        f"(sin likes {len(r.mios_sin_likes)})" + (" · ¡LIKE NUEVO!" if r.urgente else "")
    )
    if hay_que_avisar(r, cfg.avisar_siempre):
        asunto, cuerpo = redactar(r, cfg.reel_url, time.time())
        enviar_aviso(cfg, asunto, cuerpo, r.urgente)
    guardar_estado(r.estado)


def main(args: list[str]) -> None:
    cargar_env(CARPETA / ".env")
    cfg = Config.desde_entorno()

    if "--prueba-aviso" in args:
        enviar_aviso(cfg, "Vigía del sorteo: aviso de prueba", "Si lees esto, los avisos funcionan.", False)
        return

    from instagrapi.exceptions import ChallengeRequired, LoginRequired, PleaseWaitFewMinutes

    cl = conectar(cfg)
    media_id = cl.media_id(cl.media_pk_from_url(cfg.reel_url))
    log(
        f"Vigilando {cfg.reel_url} cada ~{cfg.intervalo_min:g} min "
        f"(barrido completo cada {cfg.barrido_horas:g} h). Tus cuentas: {', '.join(sorted(cfg.mis_cuentas))}"
    )

    forzar = "--barrido" in args
    fallos = 0
    while True:
        try:
            una_vuelta(cfg, cl, media_id, forzar_barrido=forzar)
            forzar = False
            fallos = 0
        except ChallengeRequired:
            enviar_aviso(
                cfg,
                "⚠️ Vigía del sorteo parado: Instagram pide verificar la cuenta",
                f"Abre la app con @{cfg.ig_usuario}, confirma que eres tú y vuelve a arrancar el vigía.",
                True,
            )
            raise
        except LoginRequired:
            log("Instagram cerró la sesión; reconecto")
            cl = conectar(cfg)
        except PleaseWaitFewMinutes:
            fallos += 1
            log("Instagram pide esperar; me espero más de lo normal")
        except Exception as ex:  # noqa: BLE001 — un fallo puntual de red no debe parar el vigía
            fallos += 1
            log(f"Error en la vuelta: {ex!r}")
            if fallos == 3:
                enviar_aviso(cfg, "⚠️ Vigía del sorteo: 3 fallos seguidos", repr(ex), False)

        if "--una-vez" in args:
            return
        espera = cfg.intervalo_min * 60 * (2 ** min(fallos, 3)) + random.uniform(0, 120)
        time.sleep(espera)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        log("Parado")
