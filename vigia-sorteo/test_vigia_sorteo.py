"""Pruebas sin red: python -m unittest test_vigia_sorteo"""

import unittest

from vigia_sorteo import Comentario, analizar, hay_que_avisar, redactar

YO = {"humanidaddesdecero"}


def c(pk, usuario, likes, texto="hola"):
    return Comentario(pk=pk, usuario=usuario, texto=texto, likes=likes)


class Analisis(unittest.TestCase):
    def test_primera_vuelta_cuenta_y_siempre_avisa(self):
        r = analizar([c("1", "HumanidadDesdeCero", 0), c("2", "pepe", 0), c("3", "ana", 4)], YO, {})
        self.assertEqual(r.total, 3)
        self.assertEqual([x.pk for x in r.mios], ["1"])  # sin distinguir mayúsculas
        self.assertEqual(len(r.mios_sin_likes), 1)
        self.assertEqual([x.pk for x in r.otros_sin_likes], ["2"])
        self.assertFalse(r.urgente)
        self.assertTrue(hay_que_avisar(r, {}, False))

    def test_like_en_mi_comentario_es_urgente(self):
        previo = analizar([c("1", "humanidaddesdecero", 0)], YO, {}).estado
        r = analizar([c("1", "humanidaddesdecero", 1)], YO, previo)
        self.assertTrue(r.urgente)
        asunto, cuerpo = redactar(r, "https://x")
        self.assertIn("te han dado like", asunto)
        self.assertIn("❌ 1 likes", cuerpo)

    def test_sin_cambios_no_avisa_y_con_cambios_si(self):
        coms = [c("1", "humanidaddesdecero", 0), c("2", "pepe", 0)]
        previo = analizar(coms, YO, {}).estado
        self.assertFalse(hay_que_avisar(analizar(coms, YO, previo), previo, False))
        self.assertTrue(hay_que_avisar(analizar(coms, YO, previo), previo, True))
        mas = coms + [c("3", "luis", 0)]
        self.assertTrue(hay_que_avisar(analizar(mas, YO, previo), previo, False))

    def test_nuevo_comentario_mio_avisa(self):
        previo = analizar([c("1", "humanidaddesdecero", 2)], YO, {}).estado
        r = analizar([c("1", "humanidaddesdecero", 2), c("9", "humanidaddesdecero", 0)], YO, previo)
        self.assertTrue(hay_que_avisar(r, previo, False))
        self.assertFalse(r.urgente)  # el que ya tenía likes no vuelve a ser urgente

    def test_comentario_mio_desaparecido(self):
        previo = analizar([c("1", "humanidaddesdecero", 0)], YO, {}).estado
        r = analizar([c("2", "pepe", 0)], YO, previo)
        self.assertEqual(r.desaparecidos, ["1"])
        self.assertTrue(hay_que_avisar(r, previo, False))
        self.assertIn("ya no aparece", redactar(r, "https://x")[1])

    def test_sin_ninguno_mio_sin_likes(self):
        r = analizar([c("1", "humanidaddesdecero", 3)], YO, {})
        self.assertIn("no te queda ningún comentario sin likes", redactar(r, "https://x")[0])

    def test_aun_no_he_comentado(self):
        _, cuerpo = redactar(analizar([c("2", "pepe", 0)], YO, {}), "https://x")
        self.assertIn("no encuentro ninguno", cuerpo)


if __name__ == "__main__":
    unittest.main()
