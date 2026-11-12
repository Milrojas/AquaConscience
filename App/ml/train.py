# -*- coding: utf-8 -*-
"""Entrena los modelos A y B con los datos de la BD, imprime métricas y guarda los .joblib."""
import json

import aquaml

if __name__ == "__main__":
    g, a = aquaml.cargar_referencia()
    print("Evaluando (corte temporal para A, validación cruzada de 5 folds para B)…")
    met = aquaml.evaluar(g, a)
    print(json.dumps(met, indent=2))
    aquaml.entrenar_y_guardar()
    (aquaml.MODELS_DIR / "metricas.json").write_text(json.dumps(met, indent=2), encoding="utf-8")
    print(f"Modelos guardados en {aquaml.MODELS_DIR}")
