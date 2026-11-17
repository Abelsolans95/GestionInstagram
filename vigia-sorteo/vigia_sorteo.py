"""Vigía del sorteo: cada X minutos mira los comentarios de un reel y te avisa.

- Si a uno de TUS comentarios le dan un "me gusta" → aviso urgente para que comentes otra vez.
- Cuántos comentarios hay sin ningún "me gusta" (los tuyos y los de los demás).

Solo LEE. Nunca comenta, ni da "me gusta", ni sigue a nadie. Los comentarios del sorteo los
publicas tú a mano desde la app.

Uso:
    python vigia_sorteo.py            # bucle infinito (Ctrl+C para parar)
    python vigia_sorteo.py --una-vez  # una sola comprobación
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


@dataclass
class Config:
    ig_usuario: str
    ig_password: str
    reel_url: str
    mis_cuentas: set[str]
    intervalo_min: float = 15
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
            intervalo_min=max(5.0, float(e("INTERVALO_MIN", "15") or 15)),
            avisar_siempre=e("AVISAR_SIEMPRE", "0").strip() in ("1", "true", "si", "sí"),
            gmail_usuario=e("GMAIL_USUARIO", "").strip(),
            gmail_app_password=e("GMAIL_APP_PASSWORD", "").replace(" ", ""),
            avisar_a=(e("AVISAR_A", "") or e("GMAIL_USUARIO", "")).strip(),
            ntfy_tema=e("NTFY_TEMA", "").strip(),
        )
        if not (cfg.gmail_usuario and cfg.gmail_app_password) and not cfg.ntfy_tema:
            sys.exit("Configura al menos un aviso: GMAIL_USUARIO + GMAIL_APP_PASSWORD, o NTFY_TEMA.")
        return cfg


# --------------------------------------------------------------------------- análisis (puro)


@dataclass
class Comentario:
    pk: str
    usuario: str
    texto: str
    likes: int


@dataclass
class Resultado:
    total: int
    mios: list[Comentario]
    mios_sin_likes: list[Comentario]
    otros_sin_likes: list[Comentario]
    nuevos_likes: list[Comentario]  # tuyos que tenían 0 y ahora tienen alguno
    desaparecidos: list[str]  # tuyos que antes estaban y ya no aparecen
    estado: dict = field(default_factory=dict)

    @property
    def urgente(self) -> bool:
        return bool(self.nuevos_likes)


def analizar(comentarios: list[Comentario], mis_cuentas: set[str], estado_previo: dict) -> Resultado:
    previos: dict[str, int] = estado_previo.get("mios", {})
    mios = [c for c in comentarios if c.usuario.lower() in mis_cuentas]
    otros = [c for c in comentarios if c.usuario.lower() not in mis_cuentas]
    actuales = {c.pk: c for c in mios}

    nuevos_likes = [c for c in mios if c.likes > 0 and previos.get(c.pk) == 0]
    desaparecidos = [pk for pk in previos if pk not in actuales]

    return Resultado(
        total=len(comentarios),
        mios=mios,
        mios_sin_likes=[c for c in mios if c.likes == 0],
        otros_sin_likes=[c for c in otros if c.likes == 0],
        nuevos_likes=nuevos_likes,
        desaparecidos=desaparecidos,
        estado={
            "mios": {c.pk: c.likes for c in mios},
            "otros_sin_likes": sum(1 for c in otros if c.likes == 0),
            "mios_sin_likes": sum(1 for c in mios if c.likes == 0),
        },
    )


def hay_que_avisar(r: Resultado, estado_previo: dict, avisar_siempre: bool) -> bool:
    if avisar_siempre or not estado_previo or r.urgente or r.desaparecidos:
        return True
    return (
        r.estado["otros_sin_likes"] != estado_previo.get("otros_sin_likes")
        or r.estado["mios_sin_likes"] != estado_previo.get("mios_sin_likes")
        or set(r.estado["mios"]) != set(estado_previo.get("mios", {}))
    )


def _recorta(texto: str, n: int = 60) -> str:
    texto = " ".join(texto.split())
    return texto if len(texto) <= n else texto[: n - 1] + "…"


def redactar(r: Resultado, reel_url: str) -> tuple[str, str]:
    if r.urgente:
        asunto = f"🚨 Sorteo PS5: te han dado like en {len(r.nuevos_likes)} comentario(s). ¡Comenta otra vez!"
    elif r.mios and not r.mios_sin_likes:
        asunto = "⚠️ Sorteo PS5: no te queda ningún comentario sin likes"
    else:
        asunto = (
            f"Sorteo PS5: {len(r.otros_sin_likes)} comentarios de otros sin likes · "
            f"tú: {len(r.mios_sin_likes)} sin likes"
        )

    lineas = [f"Comprobado: {datetime.now():%d/%m %H:%M}", f"Reel: {reel_url}", ""]
    for c in r.nuevos_likes:
        lineas.append(f"❤️ Le han dado like a tu comentario «{_recorta(c.texto)}» ({c.likes} likes)")
    for pk in r.desaparecidos:
        lineas.append(f"❓ Un comentario tuyo ya no aparece (id {pk}); puede que lo hayan ocultado o borrado")
    if r.nuevos_likes or r.desaparecidos:
        lineas.append("")

    lineas.append(f"Comentarios totales: {r.total}")
    if r.mios:
        lineas.append(f"Tus comentarios: {len(r.mios)} (sin likes: {len(r.mios_sin_likes)})")
    else:
        lineas.append("Tus comentarios: no encuentro ninguno (¿has comentado ya? ¿MIS_CUENTAS está bien?)")
    for c in r.mios:
        marca = "✅ 0 likes" if c.likes == 0 else f"❌ {c.likes} likes"
        lineas.append(f"  · @{c.usuario}: «{_recorta(c.texto)}» → {marca}")
    lineas.append(f"Comentarios de otros sin ningún like: {len(r.otros_sin_likes)}")
    for c in r.otros_sin_likes[:5]:
        lineas.append(f"  · @{c.usuario}: «{_recorta(c.texto)}»")
    if len(r.otros_sin_likes) > 5:
        lineas.append(f"  … y {len(r.otros_sin_likes) - 5} más")
    return asunto, "\n".join(lineas)


# --------------------------------------------------------------------------- avisos


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


def log(texto: str) -> None:
    print(f"[{datetime.now():%d/%m %H:%M:%S}] {texto}", flush=True)


def conectar(cfg: Config):
    from instagrapi import Client
    from instagrapi.exceptions import LoginRequired, TwoFactorRequired

    cl = Client()
    cl.delay_range = [1, 3]
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


def leer_comentarios(cl, media_id: str) -> list[Comentario]:
    return [
        Comentario(pk=str(c.pk), usuario=c.user.username, texto=c.text or "", likes=int(c.like_count or 0))
        for c in cl.media_comments(media_id, amount=0)
    ]


def cargar_estado() -> dict:
    try:
        return json.loads(ARCHIVO_ESTADO.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def guardar_estado(estado: dict) -> None:
    ARCHIVO_ESTADO.write_text(json.dumps(estado, ensure_ascii=False, indent=2), encoding="utf-8")


def una_vuelta(cfg: Config, cl, media_id: str) -> None:
    previo = cargar_estado()
    comentarios = leer_comentarios(cl, media_id)
    r = analizar(comentarios, cfg.mis_cuentas, previo)
    log(
        f"{r.total} comentarios · tuyos {len(r.mios)} (sin likes {len(r.mios_sin_likes)}) · "
        f"otros sin likes {len(r.otros_sin_likes)}"
    )
    if hay_que_avisar(r, previo, cfg.avisar_siempre):
        asunto, cuerpo = redactar(r, cfg.reel_url)
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
    log(f"Vigilando {cfg.reel_url} cada ~{cfg.intervalo_min:g} min. Tus cuentas: {', '.join(sorted(cfg.mis_cuentas))}")

    fallos = 0
    while True:
        try:
            una_vuelta(cfg, cl, media_id)
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
            log(f"Error leyendo comentarios: {ex!r}")
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
