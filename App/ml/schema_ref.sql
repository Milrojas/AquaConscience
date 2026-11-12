-- Datos de referencia (los 3 CSV del modelo). Los usa Python para entrenar
-- y Node para comparar al usuario contra hogares similares.
CREATE TABLE IF NOT EXISTS ref_hogares (
  hogar_id TEXT PRIMARY KEY,
  personas INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_consumo_general (
  hogar_id                    TEXT NOT NULL,
  fecha                       TEXT NOT NULL,           -- YYYY-MM-DD
  personas                    INTEGER NOT NULL,
  litros_consumidos           REAL NOT NULL,
  litros_por_persona          REAL NOT NULL,
  dia_semana                  TEXT,
  es_anomalia_sintetica       INTEGER NOT NULL DEFAULT 0,
  promedio_7_dias             REAL,
  cambio_vs_dia_anterior_pct  REAL,
  diferencia_vs_promedio_pct  REAL,
  PRIMARY KEY (hogar_id, fecha)
);

CREATE TABLE IF NOT EXISTS ref_consumo_actividades (
  hogar_id              TEXT NOT NULL,
  fecha                 TEXT NOT NULL,
  personas              INTEGER NOT NULL,
  categoria             TEXT NOT NULL,
  litros_consumidos     REAL NOT NULL,
  litros_por_persona    REAL NOT NULL,
  dia_semana            TEXT,
  es_anomalia_sintetica INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hogar_id, fecha, categoria)
);
CREATE INDEX IF NOT EXISTS idx_refgen_personas ON ref_consumo_general(personas);
