"""Pruebas sin red: python -m unittest test_vigia_sorteo"""

import unittest

from vigia_sorteo import Comentario, hay_que_avisar, procesar, redactar, toca_barrido

YO = {"humanidaddesdecero"}
T0 = 1_700_000_000.0


def c(pk, usuario, likes, texto="hola"):
    return Comentario(pk=pk, usuario=usuario, texto=texto, likes=likes)


def barrido_inicial(*coms):
    return procesar({}, list(coms), {}, YO, True, T0)


class Logica(unittest.TestCase):
    def test_primer_barrido_encuentra_lo_mio_y_cuenta_el_resto(self):
        r = barrido_inicial(c("1", "HumanidadDesdeCero", 0), c("2", "pepe", 0), c("3", "ana", 4))
        self.assertEqual([x.pk for x in r.mios], ["1"])  # sin distinguir mayúsculas
        self.assertEqual(r.barrido["total"], 3)
        self.assertEqual(r.barrido["otros_sin_likes"], 1)
        self.assertEqual(r.barrido["ejemplos"], [["pepe", "hola"]])
        self.assertFalse(r.urgente)
        self.assertTrue(hay_que_avisar(r, False))

    def test_primer_barrido_con_likes_no_es_urgente(self):
        self.assertFalse(barrido_inicial(c("1", "humanidaddesdecero", 2)).urgente)

    def test_vuelta_rapida_consulta_likes_y_avisa_urgente(self):
        previo = barrido_inicial(c("1", "humanidaddesdecero", 0)).estado
        r = procesar(previo, [], {"1": 1}, YO, False, T0 + 900)
        self.assertTrue(r.urgente)
        self.assertTrue(hay_que_avisar(r, False))
        asunto, cuerpo = redactar(r, "https://x", T0 + 900)
        self.assertIn("te han dado like", asunto)
        self.assertIn("❌ 1 likes", cuerpo)
        self.assertIn("Último recuento completo (hace 0 h)", cuerpo.replace("ahora", "hace 0 h"))

    def test_sin_cambios_no_avisa_salvo_avisar_siempre(self):
        previo = barrido_inicial(c("1", "humanidaddesdecero", 0)).estado
        r = procesar(previo, [], {"1": 0}, YO, False, T0 + 900)
        self.assertFalse(hay_que_avisar(r, False))
        self.assertTrue(hay_que_avisar(r, True))
        self.assertIn("sin cambios", redactar(r, "https://x", T0 + 900)[0])

    def test_comentario_nuevo_en_las_primeras_paginas(self):
        previo = barrido_inicial(c("1", "humanidaddesdecero", 3)).estado
        r = procesar(previo, [c("9", "humanidaddesdecero", 0, "otra vez yo")], {"1": 3}, YO, False, T0 + 900)
        self.assertEqual([x.pk for x in r.descubiertos], ["9"])
        self.assertFalse(r.urgente)
        self.assertIn("ya vigilo tu comentario nuevo", redactar(r, "https://x", T0)[0])
        self.assertEqual(set(r.estado["mios"]), {"1", "9"})

    def test_comentario_nuevo_que_ya_llega_con_like_es_urgente(self):
        previo = barrido_inicial(c("1", "humanidaddesdecero", 3)).estado
        r = procesar(previo, [c("9", "humanidaddesdecero", 1)], {"1": 3}, YO, False, T0 + 900)
        self.assertTrue(r.urgente)

    def test_like_visto_en_las_paginas_leidas(self):
        previo = barrido_inicial(c("1", "humanidaddesdecero", 0)).estado
        r = procesar(previo, [c("1", "humanidaddesdecero", 2)], {}, YO, False, T0 + 900)
        self.assertTrue(r.urgente)

    def test_desaparecido(self):
        previo = barrido_inicial(c("1", "humanidaddesdecero", 0, "mi comentario")).estado
        r = procesar(previo, [], {"1": None}, YO, False, T0 + 900)
        self.assertEqual([x.pk for x in r.desaparecidos], ["1"])
        self.assertNotIn("1", r.estado["mios"])
        self.assertTrue(hay_que_avisar(r, False))
        self.assertIn("ya no aparece", redactar(r, "https://x", T0)[1])

    def test_sin_dato_de_likes_se_queda_como_estaba(self):
        previo = barrido_inicial(c("1", "humanidaddesdecero", 0)).estado
        r = procesar(previo, [], {}, YO, False, T0 + 900)
        self.assertEqual(r.mios[0].likes, 0)
        self.assertFalse(r.urgente)

    def test_ninguno_mio_sin_likes(self):
        previo = barrido_inicial(c("1", "humanidaddesdecero", 0)).estado
        r = procesar(previo, [], {"1": 5}, YO, False, T0 + 900)
        self.assertEqual(len(r.mios_sin_likes), 0)

    def test_aun_no_he_comentado(self):
        _, cuerpo = redactar(barrido_inicial(c("2", "pepe", 0)), "https://x", T0)
        self.assertIn("no encuentro ninguno", cuerpo)

    def test_cuando_toca_barrido(self):
        self.assertTrue(toca_barrido({}, 12, T0))  # nunca hecho
        estado = barrido_inicial(c("2", "pepe", 0)).estado
        self.assertFalse(toca_barrido(estado, 12, T0 + 11 * 3600))
        self.assertTrue(toca_barrido(estado, 12, T0 + 12 * 3600))
        self.assertFalse(toca_barrido(estado, 0, T0 + 999 * 3600))  # 0 = solo el inicial
        # una vuelta rápida conserva el dato del último barrido
        r = procesar(estado, [], {}, YO, False, T0 + 900)
        self.assertEqual(r.estado["barrido"]["cuando"], T0)


if __name__ == "__main__":
    unittest.main()
