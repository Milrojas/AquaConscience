# -*- coding: utf-8 -*-
"""Núcleo de ML de AquaConscience (extraído del notebook de Isolation Forest).

- Lee los datos de referencia desde SQLite (tablas ref_*, cargadas con import_data.py).
- Entrena / carga el Modelo A (consumo general) y el Modelo B (por actividad).
- Analiza la serie diaria de un usuario de la app y devuelve puntajes y alertas.
"""
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import IsolationForest
from sklearn.metrics import confusion_matrix, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold

BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("AQUA_DB", BASE.parent / "aquaconscience.db"))
MODELS_DIR = Path(os.environ.get("AQUA_MODELS", BASE / "models"))

SEMILLA = 42
CONTAMINACION = 0.03          # proporción esperada de días anómalos
MIN_HISTORIAL = 7             # días previos necesarios para el promedio móvil
MIN_CATEGORIAS = 2            # categorías medidas mínimas para usar el Modelo B

CATEGORIAS = ["aseo_personal", "cocina", "inodoro", "lavado_ropa", "limpieza_vivienda"]
COLS_A = ["litros_por_persona", "ratio_vs_promedio", "cambio_vs_dia_anterior_pct", "fin_de_semana"]
COLS_B = CATEGORIAS + ["total_lpp", "fin_de_semana"]

_textos = json.loads((BASE / "consejos.json").read_text(encoding="utf-8"))
CONSEJOS = _textos["consejos"]
NOMBRES = _textos["nombres"]


# ---------------------------------------------------------------- datos
def conectar():
    if not DB_PATH.exists():
        raise RuntimeError(f"No existe la base de datos {DB_PATH}. Arranca el servidor Node una vez "
                           "o ejecuta: npm run import-data")
    return sqlite3.connect(str(DB_PATH))


def cargar_referencia():
    """Devuelve (consumo_general, consumo_actividades) desde SQLite."""
    con = conectar()
    try:
        g = pd.read_sql_query("SELECT * FROM ref_consumo_general", con, parse_dates=["fecha"])
        a = pd.read_sql_query("SELECT * FROM ref_consumo_actividades", con, parse_dates=["fecha"])
    except Exception as e:
        raise RuntimeError("Faltan las tablas ref_*. Ejecuta: npm run import-data") from e
    finally:
        con.close()
    if g.empty or a.empty:
        raise RuntimeError("Las tablas ref_* están vacías. Ejecuta: npm run import-data")
    return g.sort_values(["hogar_id", "fecha"]).reset_index(drop=True), a


# ---------------------------------------------------------------- features
def features_general(g):
    d = g.copy()
    d["ratio_vs_promedio"] = (d["litros_consumidos"] / d["promedio_7_dias"]).fillna(1.0)
    d["sin_historial"] = d["promedio_7_dias"].isna().astype(int)
    d["cambio_vs_dia_anterior_pct"] = d["cambio_vs_dia_anterior_pct"].fillna(0.0)
    d["fin_de_semana"] = d["fecha"].dt.dayofweek.isin([5, 6]).astype(int)
    return d


def features_actividades(a):
    p = a.pivot_table(index=["hogar_id", "fecha", "personas"], columns="categoria",
                      values="litros_por_persona").reset_index()
    p["total_lpp"] = p[CATEGORIAS].sum(axis=1)
    p["fin_de_semana"] = p["fecha"].dt.dayofweek.isin([5, 6]).astype(int)
    y = a.groupby(["hogar_id", "fecha"])["es_anomalia_sintetica"].max().rename("es_anomalia").reset_index()
    return p.merge(y, on=["hogar_id", "fecha"])


def nuevo_modelo():
    return IsolationForest(n_estimators=300, contamination=CONTAMINACION,
                           random_state=SEMILLA, n_jobs=-1)


# ---------------------------------------------------------------- entrenamiento
def evaluar(g, a):
    """Mismas métricas del notebook (A: corte temporal; B: validación cruzada 5 folds)."""
    dg = features_general(g)
    corte = pd.Timestamp("2026-03-11")
    tr, te = dg[dg.fecha < corte], dg[dg.fecha >= corte]
    m = nuevo_modelo().fit(tr[COLS_A])
    y = te["es_anomalia_sintetica"]
    pred = (m.predict(te[COLS_A]) == -1).astype(int)
    res = {"A": {"roc_auc": float(roc_auc_score(y, -m.decision_function(te[COLS_A]))),
                 "precision": float(precision_score(y, pred)),
                 "recall": float(recall_score(y, pred)),
                 "matriz_confusion": confusion_matrix(y, pred).tolist()}}
    db = features_actividades(a)
    filas = []
    for tr_i, te_i in StratifiedKFold(5, shuffle=True, random_state=SEMILLA).split(db[COLS_B], db["es_anomalia"]):
        mb = nuevo_modelo().fit(db.iloc[tr_i][COLS_B])
        yt = db.iloc[te_i]["es_anomalia"]
        pr = (mb.predict(db.iloc[te_i][COLS_B]) == -1).astype(int)
        filas.append([roc_auc_score(yt, -mb.decision_function(db.iloc[te_i][COLS_B])),
                      precision_score(yt, pr, zero_division=0), recall_score(yt, pr)])
    m_ = np.mean(filas, axis=0)
    res["B"] = {"roc_auc": float(m_[0]), "precision": float(m_[1]), "recall": float(m_[2])}
    return res


def entrenar_y_guardar():
    g, a = cargar_referencia()
    dg, db = features_general(g), features_actividades(a)
    modelo_a = nuevo_modelo().fit(dg[COLS_A])
    modelo_b = nuevo_modelo().fit(db[COLS_B])
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    meta = {"sklearn": sklearn.__version__, "entrenado": datetime.now().isoformat(timespec="seconds")}
    # Mismo formato que el notebook: {"modelo": ..., "columnas": [...]}
    joblib.dump({"modelo": modelo_a, "columnas": COLS_A, **meta, "filas": len(dg)}, MODELS_DIR / "modelo_A_general.joblib")
    joblib.dump({"modelo": modelo_b, "columnas": COLS_B, **meta, "filas": len(db)}, MODELS_DIR / "modelo_B_actividades.joblib")
    return modelo_a, modelo_b


def _cargar(nombre):
    ruta = MODELS_DIR / nombre
    if not ruta.exists():
        return None
    try:
        b = joblib.load(ruta)
        if b.get("sklearn") and b["sklearn"] != sklearn.__version__:
            print(f"[ml] {nombre} fue entrenado con scikit-learn {b['sklearn']} (ahora {sklearn.__version__}); se reentrena.")
            return None
        return b["modelo"]
    except Exception as e:
        print(f"[ml] No se pudo cargar {nombre}: {e}. Se reentrena.")
        return None


# ---------------------------------------------------------------- motor
def _f(x):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else float(x)


class Motor:
    def __init__(self):
        g, a = cargar_referencia()
        db = features_actividades(a)
        # Valores "típicos" por categoría (para alertas por actividad e imputación)
        self.base = {}
        for c in CATEGORIAS:
            med = float(db[c].median())
            mad = float((db[c] - med).abs().median() * 1.4826) or 1e-9
            self.base[c] = (med, mad)
        self.modelo_a = _cargar("modelo_A_general.joblib")
        self.modelo_b = _cargar("modelo_B_actividades.joblib")
        if self.modelo_a is None or self.modelo_b is None:
            print("[ml] Entrenando modelos desde la base de datos…")
            self.modelo_a, self.modelo_b = entrenar_y_guardar()
        self.info = {"sklearn": sklearn.__version__, "filas_general": int(len(g)),
                     "filas_actividades": int(len(db)), "hogares_referencia": int(g.hogar_id.nunique())}

    # ---- Modelo A
    def _general(self, personas, dias):
        n = len(dias)
        if n < MIN_HISTORIAL + 1:
            return [], {"ok": False, "motivo": f"Se necesitan al menos {MIN_HISTORIAL + 1} días completos de lecturas ({n} disponibles)."}
        x = pd.DataFrame({"fecha": pd.to_datetime([d["fecha"] for d in dias]),
                          "litros_consumidos": [float(d["litros"]) for d in dias]})
        x["personas"] = personas
        x["litros_por_persona"] = x.litros_consumidos / personas
        x["promedio_7_dias"] = x.litros_consumidos.rolling(MIN_HISTORIAL).mean().shift(1)
        x["cambio_vs_dia_anterior_pct"] = (x.litros_consumidos.pct_change(fill_method=None) * 100) \
            .replace([np.inf, -np.inf], np.nan)
        f = features_general(x)
        ok = f.sin_historial == 0
        f["score"], f["anom"] = np.nan, False
        X = f.loc[ok, COLS_A]
        f.loc[ok, "score"] = -self.modelo_a.decision_function(X)
        f.loc[ok, "anom"] = self.modelo_a.predict(X) == -1
        return f, {"ok": True}

    def _alerta_general(self, r):
        ratio = float(r.ratio_vs_promedio)
        t = f"El {r.fecha:%d/%m} usaste {r.litros_consumidos:.0f} L"
        if r.personas > 1:
            t += f" ({r.litros_por_persona:.0f} L por persona)"
        t += f". Tu promedio de los 7 días anteriores era {r.promedio_7_dias:.0f} L ({100 * (ratio - 1):+.0f} %)."
        return {"fecha": f"{r.fecha:%Y-%m-%d}", "modelo": "general", "categoria": None,
                "direccion": "alto" if ratio >= 1 else "bajo", "score": _f(r.score),
                "litros": _f(r.litros_consumidos), "ratio": _f(ratio), "texto": t,
                "consejo": CONSEJOS["general"] if ratio >= 1 else CONSEJOS["general_bajo"]}

    # ---- Modelo B
    def _actividades(self, personas, dias):
        filas, meta = [], []
        for d in dias:
            cats = d.get("categorias") or {}
            lpp = {c: float(cats[c]) / personas for c in CATEGORIAS if cats.get(c) is not None}
            if len(lpp) < MIN_CATEGORIAS:
                continue
            fila = {c: lpp.get(c, self.base[c][0]) for c in CATEGORIAS}   # imputa lo no medido con la mediana
            fila["total_lpp"] = sum(fila.values())
            fila["fecha"] = pd.Timestamp(d["fecha"])
            fila["fin_de_semana"] = int(fila["fecha"].dayofweek in (5, 6))
            filas.append(fila)
            meta.append({"medidas": lpp, "imputadas": [c for c in CATEGORIAS if c not in lpp]})
        if not filas:
            return [], [], {"ok": False, "motivo": "Ningún día tiene al menos 2 actividades medidas "
                                                   "(se necesitan sensores por punto o actividades reportadas)."}
        df = pd.DataFrame(filas)
        df["score"] = -self.modelo_b.decision_function(df[COLS_B])
        df["anom"] = self.modelo_b.predict(df[COLS_B]) == -1
        return df, meta, {"ok": True}

    def _alerta_actividades(self, r, m):
        z = {c: (v - self.base[c][0]) / self.base[c][1] for c, v in m["medidas"].items()}
        peor = max(z, key=z.get)
        fecha = f"{r.fecha:%Y-%m-%d}"
        if sum(v > 3 for v in z.values()) >= 3:   # casi todo subió a la vez: no es una sola actividad
            return {"fecha": fecha, "modelo": "actividades", "categoria": None, "direccion": "alto",
                    "score": _f(r.score), "litros": _f(r.total_lpp), "ratio": None,
                    "texto": f"El {r.fecha:%d/%m} varias actividades superaron a la vez lo típico "
                             f"({r.total_lpp:.0f} L por persona en total).",
                    "consejo": CONSEJOS["general"]}
        if z[peor] <= 1:   # ninguna actividad sobresale: patrón combinado raro
            return {"fecha": fecha, "modelo": "actividades", "categoria": None, "direccion": "alto",
                    "score": _f(r.score), "litros": _f(r.total_lpp), "ratio": None,
                    "texto": f"El {r.fecha:%d/%m} el patrón de uso por actividades fue inusual frente a lo típico.",
                    "consejo": CONSEJOS["general"]}
        tip = self.base[peor][0]
        return {"fecha": fecha, "modelo": "actividades", "categoria": peor, "direccion": "alto",
                "score": _f(r.score), "litros": _f(m["medidas"][peor] * 1), "ratio": _f(m["medidas"][peor] / tip),
                "texto": (f"El {r.fecha:%d/%m} el mayor exceso estuvo en {NOMBRES[peor]}: "
                          f"{m['medidas'][peor]:.0f} L por persona, cuando lo típico es {tip:.0f} L."),
                "consejo": CONSEJOS[peor]}

    # ---- API
    def analizar(self, personas, dias):
        dias = sorted(dias, key=lambda d: d["fecha"])
        out = {d["fecha"]: {"fecha": d["fecha"], "litros": float(d["litros"]),
                            "litros_por_persona": float(d["litros"]) / personas,
                            "ratio_vs_promedio": None, "score_general": None, "anomalia_general": None,
                            "score_actividades": None, "anomalia_actividades": None, "imputadas": []}
               for d in dias}
        alertas = []

        fg, mg = self._general(personas, dias)
        if mg["ok"]:
            for r in fg.itertuples():
                k = f"{r.fecha:%Y-%m-%d}"
                if r.sin_historial:
                    continue
                out[k].update(ratio_vs_promedio=_f(r.ratio_vs_promedio), score_general=_f(r.score),
                              anomalia_general=bool(r.anom))
                if r.anom:
                    alertas.append(self._alerta_general(r))

        fb, meta, mb = self._actividades(personas, dias)
        if mb["ok"]:
            for r, m in zip(fb.itertuples(), meta):
                k = f"{r.fecha:%Y-%m-%d}"
                out[k].update(score_actividades=_f(r.score), anomalia_actividades=bool(r.anom),
                              imputadas=m["imputadas"])
                if r.anom:
                    alertas.append(self._alerta_actividades(r, m))

        alertas.sort(key=lambda a: (a["fecha"], a["modelo"]), reverse=True)
        return {"modelos": {"general": mg, "actividades": mb},
                "dias": list(out.values()), "alertas": alertas, "info": self.info}
