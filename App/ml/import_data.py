# -*- coding: utf-8 -*-
"""Carga los 3 CSV del modelo en la base de datos de la app (tablas ref_*).

Uso:  python ml/import_data.py [--data ../data] [--db ../aquaconscience.db]
Es idempotente: reemplaza el contenido de las tablas ref_* cada vez.
Nota: AQUACONSIENCE_hogares.csv en realidad es un Excel (.xlsx) con extensión .csv;
el script detecta el formato real por los bytes iniciales.
"""
import argparse
import glob
import sqlite3
from pathlib import Path

import pandas as pd

BASE = Path(__file__).resolve().parent


def leer_tabla(ruta, **kw):
    with open(ruta, "rb") as f:
        es_xlsx = f.read(2) == b"PK"          # los .xlsx son zips
    return pd.read_excel(ruta) if es_xlsx else pd.read_csv(ruta, **kw)


def buscar(data_dir, clave):
    hits = sorted(glob.glob(str(data_dir / f"*{clave}*")))
    if not hits:
        raise SystemExit(f"No encontré un archivo con '{clave}' en {data_dir}")
    return hits[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(BASE.parent / "data"))
    ap.add_argument("--db", default=str(BASE.parent / "aquaconscience.db"))
    args = ap.parse_args()
    data_dir = Path(args.data)

    h = leer_tabla(buscar(data_dir, "hogares"))
    g = leer_tabla(buscar(data_dir, "consumo_general"))
    a = leer_tabla(buscar(data_dir, "consumo_actividades"))

    for df in (g, a):
        df["fecha"] = pd.to_datetime(df["fecha"]).dt.strftime("%Y-%m-%d")
        df["es_anomalia_sintetica"] = df["es_anomalia_sintetica"].astype(int)

    # Validaciones básicas de integridad
    faltan = (set(g.hogar_id) | set(a.hogar_id)) - set(h.hogar_id)
    if faltan:
        raise SystemExit(f"Hay hogares sin registro en 'hogares': {sorted(faltan)[:5]}…")
    if (g.litros_consumidos < 0).any() or (a.litros_consumidos < 0).any():
        raise SystemExit("Hay litros negativos en los datos.")

    con = sqlite3.connect(args.db)
    con.executescript((BASE / "schema_ref.sql").read_text(encoding="utf-8"))
    cols_g = ["hogar_id", "fecha", "personas", "litros_consumidos", "litros_por_persona", "dia_semana",
              "es_anomalia_sintetica", "promedio_7_dias", "cambio_vs_dia_anterior_pct", "diferencia_vs_promedio_pct"]
    cols_a = ["hogar_id", "fecha", "personas", "categoria", "litros_consumidos", "litros_por_persona",
              "dia_semana", "es_anomalia_sintetica"]

    def filas(df, cols):   # NaN -> NULL
        return [tuple(None if pd.isna(v) else (v.item() if hasattr(v, "item") else v) for v in r)
                for r in df[cols].itertuples(index=False, name=None)]

    with con:
        for t in ("ref_consumo_actividades", "ref_consumo_general", "ref_hogares"):
            con.execute(f"DELETE FROM {t}")
        con.executemany("INSERT INTO ref_hogares VALUES (?,?)", filas(h, ["hogar_id", "personas"]))
        con.executemany(f"INSERT INTO ref_consumo_general ({','.join(cols_g)}) VALUES ({','.join('?' * len(cols_g))})", filas(g, cols_g))
        con.executemany(f"INSERT INTO ref_consumo_actividades ({','.join(cols_a)}) VALUES ({','.join('?' * len(cols_a))})", filas(a, cols_a))
    for t in ("ref_hogares", "ref_consumo_general", "ref_consumo_actividades"):
        print(f"{t}: {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]} filas")
    con.close()
    print("Listo. Ahora entrena/arranca el servicio:  npm run train  |  npm run ml")


if __name__ == "__main__":
    main()
