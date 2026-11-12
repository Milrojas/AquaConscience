# -*- coding: utf-8 -*-
"""Microservicio de ML (Flask). Solo lo llama el backend Node, en la misma máquina.

  POST /analyze   {personas, dias:[{fecha:'YYYY-MM-DD', litros, categorias?:{aseo_personal:..}}]}
  GET  /health
Por seguridad escucha solo en 127.0.0.1 (no lo expongas a Internet: no tiene autenticación).
"""
import math
import os
import re

from flask import Flask, jsonify, request

import aquaml

app = Flask(__name__)
motor = aquaml.Motor()
FECHA = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _error(msg, code=400):
    return jsonify({"error": msg}), code


@app.get("/health")
def health():
    return jsonify({"ok": True, **motor.info})


@app.post("/analyze")
def analyze():
    b = request.get_json(silent=True) or {}
    try:
        personas = int(b.get("personas"))
    except (TypeError, ValueError):
        return _error("personas inválido")
    dias = b.get("dias")
    if not 1 <= personas <= 12 or not isinstance(dias, list) or not 1 <= len(dias) <= 120:
        return _error("Parámetros fuera de rango (personas 1-12, dias 1-120).")
    limpios, vistos = [], set()
    for d in dias:
        try:
            fecha, litros = str(d["fecha"]), float(d["litros"])
        except (KeyError, TypeError, ValueError):
            return _error("Cada día necesita 'fecha' y 'litros'.")
        if not FECHA.match(fecha) or not math.isfinite(litros) or litros < 0 or fecha in vistos:
            return _error(f"Día inválido o repetido: {fecha}")
        vistos.add(fecha)
        cats = {k: float(v) for k, v in (d.get("categorias") or {}).items()
                if k in aquaml.CATEGORIAS and isinstance(v, (int, float)) and math.isfinite(v) and v >= 0}
        limpios.append({"fecha": fecha, "litros": litros, "categorias": cats})
    return jsonify(motor.analizar(personas, limpios))


if __name__ == "__main__":
    port = int(os.environ.get("ML_PORT", 5001))
    print(f"Servicio ML en http://127.0.0.1:{port}  ({motor.info})")
    app.run(host="127.0.0.1", port=port, threaded=True)
