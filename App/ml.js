/* Conexión con el modelo de ML (servicio Python) + datos de referencia de los CSV en SQLite.
 *
 *  analyze(userId)  -> agrega las lecturas del usuario por día, las envía al servicio
 *                      (POST /analyze) y devuelve puntajes, alertas y estadísticas.
 *                      Si el servicio no responde, usa una regla simple (fuente: 'reglas')
 *                      para que la app nunca se caiga.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const TZ = process.env.TZ_APP || 'America/Bogota';
const ML_URL = process.env.ML_URL || 'http://127.0.0.1:5001';
const ML_TIMEOUT_MS = 8000;
const CACHE_MS = 60_000;
const HISTORY_DAYS = 45;
const MIN_HISTORIAL = 7;

const { consejos: CONSEJOS, nombres: NOMBRES } =
  JSON.parse(fs.readFileSync(path.join(__dirname, 'ml', 'consejos.json'), 'utf8'));

const dayKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });

/* Actividad reportada por el sensor -> categoría del modelo.
   Riego / Uso general / Consumo general cuentan para el total pero no tienen categoría. */
const ACT_TO_CAT = {
  'Ducha': 'aseo_personal', 'Lavamanos': 'aseo_personal', 'Sanitario': 'inodoro',
  'Lavado de platos': 'cocina', 'Preparar comida': 'cocina',
  'Lavadora': 'lavado_ropa', 'Limpieza': 'limpieza_vivienda'
};
const LOC_TO_CAT = { 'Cocina': 'cocina', 'Baño': 'aseo_personal', 'Lavandería': 'lavado_ropa' };

/* ---------- Serie diaria del usuario ---------- */
function buildSeries(userId, personas) {
  const rows = db.prepare(`
    SELECT r.liters, r.activity, r.created_at, s.loc
    FROM readings r JOIN sensors s ON s.id = r.sensor_id
    WHERE r.user_id = ? AND r.created_at >= ?`).all(userId, Date.now() - HISTORY_DAYS * 864e5);
  const today = dayKey(Date.now());
  const byDay = {};
  for (const r of rows) {
    const k = dayKey(r.created_at);
    if (k === today) continue;                       // el día en curso está incompleto
    const d = (byDay[k] ||= { fecha: k, litros: 0, categorias: {} });
    d.litros += r.liters;
    const cat = r.activity ? ACT_TO_CAT[r.activity] : LOC_TO_CAT[r.loc];
    if (cat) d.categorias[cat] = (d.categorias[cat] || 0) + r.liters;
  }
  const dias = Object.values(byDay).sort((a, b) => a.fecha.localeCompare(b.fecha));
  return { personas, dias };
}

/* ---------- Datos de referencia (CSV -> SQLite) ---------- */
let _ref = null;
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function refStats() {
  if (_ref) return _ref;
  if (!db.prepare('SELECT COUNT(*) c FROM ref_hogares').get().c) return null;
  const byCat = {};
  db.prepare('SELECT categoria c, litros_por_persona v FROM ref_consumo_actividades WHERE es_anomalia_sintetica=0')
    .all().forEach(r => (byCat[r.c] ||= []).push(r.v));
  const medianas = Object.fromEntries(Object.entries(byCat).map(([c, v]) => [c, median(v)]));
  const porPersonas = {};
  db.prepare(`SELECT personas p, AVG(litros_por_persona) m, COUNT(DISTINCT hogar_id) n
              FROM ref_consumo_general WHERE es_anomalia_sintetica=0 GROUP BY personas`)
    .all().forEach(r => (porPersonas[r.p] = { lpp: r.m, n: r.n }));
  return (_ref = { medianas, porPersonas });
}

function similares(personas) {
  const ref = refStats();
  if (!ref) return null;
  const keys = Object.keys(ref.porPersonas).map(Number);
  if (!keys.length) return null;
  const k = keys.reduce((a, b) => (Math.abs(b - personas) < Math.abs(a - personas) ? b : a));
  return { personas: k, lpp: ref.porPersonas[k].lpp, n_hogares: ref.porPersonas[k].n, exacto: k === personas };
}

/* ---------- Estadísticas semanales (últimos 7 días completos) ---------- */
function computeStats(serie) {
  const d = serie.dias, sem = d.slice(-7), ant = d.slice(-14, -7);
  if (!sem.length) return null;
  const sum = a => a.reduce((x, y) => x + y.litros, 0);
  const mayor = sem.reduce((a, b) => (b.litros > a.litros ? b : a));
  return {
    dias_considerados: sem.length,
    litros_semana: Math.round(sum(sem)),
    litros_por_persona_dia: +(sum(sem) / sem.length / serie.personas).toFixed(1),
    dia_mayor_consumo: { fecha: mayor.fecha, litros: Math.round(mayor.litros) },
    cambio_vs_semana_anterior_pct: ant.length === 7 ? +(100 * (sum(sem) / sum(ant) - 1)).toFixed(1) : null,
    similares: similares(serie.personas)
  };
}

/* ---------- Llamada al servicio / respaldo ---------- */
async function callService(serie) {
  const r = await fetch(ML_URL + '/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personas: serie.personas, dias: serie.dias }),
    signal: AbortSignal.timeout(ML_TIMEOUT_MS)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Servicio ML respondió ${r.status}`);
  return data;
}

/* Respaldo sin ML: compara cada día con el promedio de los 7 anteriores. */
function fallbackAnalysis(serie, motivo) {
  const { dias, personas } = serie;
  const out = dias.map(d => ({ fecha: d.fecha, litros: d.litros, litros_por_persona: d.litros / personas,
    ratio_vs_promedio: null, score_general: null, anomalia_general: null,
    score_actividades: null, anomalia_actividades: null, imputadas: [] }));
  const alertas = [];
  for (let i = MIN_HISTORIAL; i < dias.length; i++) {
    const prev = dias.slice(i - MIN_HISTORIAL, i).reduce((a, d) => a + d.litros, 0) / MIN_HISTORIAL;
    const ratio = dias[i].litros / prev;
    out[i].ratio_vs_promedio = ratio;
    out[i].anomalia_general = ratio >= 1.5 || ratio <= 0.5;
    if (out[i].anomalia_general) {
      const [, m, dd] = dias[i].fecha.split('-');
      alertas.push({ fecha: dias[i].fecha, modelo: 'reglas', categoria: null,
        direccion: ratio >= 1 ? 'alto' : 'bajo', score: null, litros: dias[i].litros, ratio,
        texto: `El ${dd}/${m} usaste ${Math.round(dias[i].litros)} L; tu promedio de los 7 días anteriores era ` +
               `${Math.round(prev)} L (${ratio >= 1 ? '+' : ''}${Math.round(100 * (ratio - 1))} %).`,
        consejo: ratio >= 1 ? CONSEJOS.general : CONSEJOS.general_bajo });
    }
  }
  alertas.reverse();
  const ok = dias.length >= MIN_HISTORIAL + 1;
  return { modelos: { general: ok ? { ok: true } : { ok: false, motivo: `Se necesitan al menos ${MIN_HISTORIAL + 1} días completos de lecturas (${dias.length} disponibles).` },
                      actividades: { ok: false, motivo: motivo || 'Servicio de ML no disponible.' } },
           dias: out, alertas };
}

/* ---------- Persistencia de alertas ---------- */
const upsertAlert = db.prepare(`
  INSERT INTO alerts(user_id,day,model,category,direction,score,liters,message,advice,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(user_id,day,model) DO UPDATE SET category=excluded.category, direction=excluded.direction,
    score=excluded.score, liters=excluded.liters, message=excluded.message, advice=excluded.advice`);
const saveAlerts = db.transaction((userId, alertas) => {
  for (const a of alertas)
    upsertAlert.run(userId, a.fecha, a.modelo, a.categoria, a.direccion, a.score, a.litros, a.texto, a.consejo, Date.now());
});

/* ---------- API pública ---------- */
const cache = new Map();   // userId -> { t, p:Promise }

async function run(userId) {
  const h = db.prepare('SELECT members FROM households WHERE user_id=?').get(userId);
  if (!h) return null;
  const serie = buildSeries(userId, h.members);
  let res, fuente = 'modelo', aviso = null;
  try {
    res = await callService(serie);
  } catch (e) {
    fuente = 'reglas'; aviso = e.name === 'TimeoutError' ? 'El servicio de ML tardó demasiado.' : e.message;
    res = fallbackAnalysis(serie, aviso);
  }
  if (!serie.dias.length) fuente = 'sin_datos';
  const analysis = { fuente, aviso, serie, modelos: res.modelos, dias: res.dias, alertas: res.alertas,
                     estadisticas: computeStats(serie) };
  try { saveAlerts(userId, analysis.alertas); } catch (e) { console.error('No se pudieron guardar alertas:', e.message); }
  return analysis;
}

function analyze(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.p;
  const p = run(userId).catch(e => { cache.delete(userId); throw e; });
  cache.set(userId, { t: Date.now(), p });
  return p;
}
const invalidate = userId => cache.delete(userId);

/* Alertas recientes, una por día (la del modelo por actividades es más específica), listas para la UI. */
function recentAlerts(analysis, days = 14) {
  if (!analysis) return [];
  const desde = dayKey(Date.now() - days * 864e5);
  const porDia = {};
  for (const a of analysis.alertas) {
    if (a.fecha < desde) continue;
    const cur = porDia[a.fecha];
    if (!cur || (a.modelo === 'actividades' && a.categoria)) porDia[a.fecha] = a;
  }
  return Object.values(porDia).sort((a, b) => b.fecha.localeCompare(a.fecha)).map(a => {
    const [, m, d] = a.fecha.split('-');
    const titulo = a.categoria ? `Exceso en ${NOMBRES[a.categoria]} · ${d}/${m}`
      : a.direccion === 'bajo' ? `Consumo inusualmente bajo · ${d}/${m}` : `Consumo inusual · ${d}/${m}`;
    return { fecha: a.fecha, modelo: a.modelo, categoria: a.categoria, direccion: a.direccion,
             titulo, texto: a.texto, consejo: a.consejo };
  });
}

async function health() {
  try {
    const r = await fetch(ML_URL + '/health', { signal: AbortSignal.timeout(2500) });
    return { disponible: r.ok, ...(await r.json().catch(() => ({}))) };
  } catch (e) { return { disponible: false, error: e.message }; }
}

module.exports = { analyze, invalidate, recentAlerts, refStats, health, CONSEJOS, NOMBRES, dayKey };
