import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

bundle = joblib.load("modelo_A_general.joblib")
modelo, COLS = bundle["modelo"], bundle["columnas"]


class Dia(BaseModel):
    fecha: str
    litros: float


class Peticion(BaseModel):
    personas: int
    dias: list[Dia]


@app.get("/salud")
def salud():
    return {"ok": True}


@app.post("/predecir")
def predecir(p: Peticion):
    df = pd.DataFrame([d.model_dump() for d in p.dias])
    df["fecha"] = pd.to_datetime(df["fecha"])
    df = df.sort_values("fecha").reset_index(drop=True)

    df["litros_por_persona"] = df["litros"] / max(p.personas, 1)
    prom_7 = df["litros"].shift(1).rolling(7).mean()
    df["ratio_vs_promedio"] = (df["litros"] / prom_7).replace([np.inf, -np.inf], np.nan).fillna(1.0)
    df["cambio_vs_dia_anterior_pct"] = (
        (df["litros"].pct_change() * 100).replace([np.inf, -np.inf], np.nan).fillna(0.0)
    )
    df["fin_de_semana"] = (df["fecha"].dt.dayofweek >= 5).astype(int)

    X = df[COLS]
    df["es_anomalia"] = modelo.predict(X) == -1
    df["puntaje"] = -modelo.decision_function(X)
    df["con_historial"] = prom_7.notna()

    return {"dias": [
        {
            "fecha": r.fecha.strftime("%Y-%m-%d"),
            "litros": round(r.litros),
            "litros_por_persona": round(r.litros_por_persona),
            "cambio_vs_dia_anterior_pct": round(r.cambio_vs_dia_anterior_pct),
            "es_anomalia": bool(r.es_anomalia),
            "puntaje": round(float(r.puntaje), 3),
            "con_historial_de_7_dias": bool(r.con_historial),
        }
        for r in df.itertuples()
    ]}
