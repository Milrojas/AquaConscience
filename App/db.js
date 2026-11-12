const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const db = new Database(process.env.AQUA_DB || path.join(__dirname, 'aquaconscience.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS households (
  user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  household TEXT NOT NULL CHECK (household IN ('solo','familia')),
  members   INTEGER NOT NULL DEFAULT 1,
  type      TEXT NOT NULL CHECK (type IN ('general','puntos'))
);

CREATE TABLE IF NOT EXISTS sensors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  loc        TEXT NOT NULL,
  api_key    TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Consumo detectado por cada dispositivo
CREATE TABLE IF NOT EXISTS readings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor_id  INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  liters     REAL NOT NULL CHECK (liters >= 0),
  activity   TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readings_user_time ON readings(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sensors_user ON sensors(user_id);

-- Alertas generadas por el modelo de ML (historial por usuario)
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,              -- YYYY-MM-DD (zona horaria de la app)
  model      TEXT NOT NULL,              -- 'general' | 'actividades' | 'reglas'
  category   TEXT,
  direction  TEXT,                       -- 'alto' | 'bajo'
  score      REAL,
  liters     REAL,
  message    TEXT NOT NULL,
  advice     TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, day, model)
);
CREATE INDEX IF NOT EXISTS idx_alerts_user_day ON alerts(user_id, day);

-- Facturas del servicio de agua (ingresadas a mano o leídas de un escaneo)
CREATE TABLE IF NOT EXISTS bills (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start   TEXT NOT NULL,          -- YYYY-MM-DD
  period_end     TEXT NOT NULL,          -- YYYY-MM-DD
  m3             REAL NOT NULL CHECK (m3 >= 0),     -- consumo facturado
  total          REAL NOT NULL CHECK (total >= 0),  -- valor total a pagar (COP)
  invoice_number TEXT,
  source         TEXT NOT NULL DEFAULT 'manual',    -- 'manual' | 'scan'
  created_at     INTEGER NOT NULL,
  UNIQUE (user_id, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_bills_user ON bills(user_id, period_end);
`);

// Tablas ref_* (datos de los CSV del modelo). Mismo esquema que usa ml/import_data.py
db.exec(fs.readFileSync(path.join(__dirname, 'ml', 'schema_ref.sql'), 'utf8'));
if (!db.prepare('SELECT COUNT(*) c FROM ref_consumo_general').get().c) {
  console.warn('⚠️  Las tablas ref_* están vacías. Carga los CSV con: npm run import-data');
}

module.exports = db;