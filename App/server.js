const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const ml = require('./ml');
const chatbot = require('./chatbot');
const bills = require('./bills');
const { PRICE_M3, costL, cop } = require('./pricing');
const { getExcess } = require('./limits');

const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ_APP || 'America/Bogota';
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️  JWT_SECRET no definido: se usa uno temporal (las sesiones se pierden al reiniciar).');
}

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Helpers ---------- */
const now = () => Date.now();
const newKey = () => 'aqk_' + crypto.randomBytes(18).toString('hex');
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const signToken = id => jwt.sign({ uid: id }, JWT_SECRET, { expiresIn: '30d' });
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const dayKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const rand = (a, b) => a + Math.random() * (b - a);

const LIMIT_PER_PERSON_DAY = 100; // L/persona/día (referencia OMS ~100 L)

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return fail(res, 401, 'Sesión no válida.');
  try {
    req.userId = jwt.verify(token, JWT_SECRET).uid;
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(req.userId)) return fail(res, 401, 'Sesión no válida.');
    next();
  } catch { return fail(res, 401, 'Sesión expirada.'); }
}

function whenLabel(ts) {
  const d = dayKey(ts), today = dayKey(now()), yest = dayKey(now() - 864e5);
  const hora = new Date(ts).toLocaleTimeString('es-CO', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  if (d === today) return 'Hoy, ' + hora;
  if (d === yest) return 'Ayer, ' + hora;
  const f = new Date(ts).toLocaleDateString('es-CO', { timeZone: TZ, day: 'numeric', month: 'short' });
  return f + ', ' + hora;
}

function getActivities(userId, limit) {
  return db.prepare(`
    SELECT r.liters, r.activity, r.created_at, s.name AS sensor
    FROM readings r JOIN sensors s ON s.id = r.sensor_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT ?`).all(userId, limit)
    .map(r => ({ who: r.activity || r.sensor, t: `${r.sensor} · ${whenLabel(r.created_at)}`, l: Math.round(r.liters) }));
}

/* ---------- AUTH ---------- */
app.post('/api/auth/signup', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !emailOk(email) || password.length < 6)
    return fail(res, 400, 'Datos inválidos (nombre, correo válido y contraseña de 6+ caracteres).');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email))
    return fail(res, 409, 'Ese correo ya está registrado.');
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users(name,email,password_hash,created_at) VALUES(?,?,?,?)')
    .run(name, email, hash, now());
  res.status(201).json({ token: signToken(info.lastInsertRowid) });
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !bcrypt.compareSync(password, u.password_hash))
    return fail(res, 401, 'Correo o contraseña incorrectos.');
  res.json({ token: signToken(u.id) });
});

/* ---------- PERFIL ---------- */
app.get('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT id,name,email FROM users WHERE id=?').get(req.userId);
  const h = db.prepare('SELECT household,members,type FROM households WHERE user_id=?').get(req.userId);
  res.json({ onboarded: !!h, user: u, household: h || null });
});

app.put('/api/me', auth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const household = req.body.household;
  let members = parseInt(req.body.members) || 1;
  if (!name || !emailOk(email)) return fail(res, 400, 'Nombre o correo inválido.');
  if (!['solo', 'familia'].includes(household)) return fail(res, 400, 'Tipo de hogar inválido.');
  members = household === 'solo' ? 1 : Math.min(Math.max(members, 2), 12);
  const dup = db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(email, req.userId);
  if (dup) return fail(res, 409, 'Ese correo ya está en uso.');
  db.prepare('UPDATE users SET name=?, email=? WHERE id=?').run(name, email, req.userId);
  db.prepare('UPDATE households SET household=?, members=? WHERE user_id=?').run(household, members, req.userId);
  ml.invalidate(req.userId);
  res.json({ ok: true });
});

/* ---------- ONBOARDING ---------- */
/* Datos de demostración: 21 días (el modelo necesita ≥8 días completos) con las mismas
   proporciones por actividad del dataset de referencia y un día anómalo para ver las alertas. */
const DEMO_DAYS = 21, DEMO_SPIKE_DAY = 3;     // el pico ocurre hace 3 días
const DEMO_SHARES = [                         // [actividad, ubicación del sensor, % del consumo diario]
  ['Ducha', 'Baño', .47], ['Lavamanos', 'Baño', .10], ['Sanitario', 'Baño', .10],
  ['Lavado de platos', 'Cocina', .15], ['Preparar comida', 'Cocina', .08],
  ['Lavadora', 'Lavandería', .07], ['Limpieza', 'Otro', .03]
];
function tzHM(ts) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(ts));
  return { h: +p.find(x => x.type === 'hour').value, m: +p.find(x => x.type === 'minute').value };
}
/* Timestamp a la hora `hour` (hora local de TZ) del día (hoy - daysAgo) */
function localTs(daysAgo, hour) {
  const base = now() - daysAgo * 864e5, { h, m } = tzHM(base);
  return base - (h - hour) * 36e5 - m * 6e4 + Math.floor(rand(0, 59)) * 6e4;
}

function seedDemo(userId, members, type) {
  const sensors = db.prepare('SELECT id,loc FROM sensors WHERE user_id=?').all(userId);
  if (!sensors.length) return;
  const ins = db.prepare('INSERT INTO readings(sensor_id,user_id,liters,activity,created_at) VALUES(?,?,?,?,?)');
  const tx = db.transaction(() => {
    for (let d = DEMO_DAYS; d >= 0; d--) {
      const spike = d === DEMO_SPIKE_DAY;
      const total = members * LIMIT_PER_PERSON_DAY * rand(0.88, 1.12);
      const put = (sensor, liters, act) => {
        const ts = localTs(d, Math.floor(rand(6, 22)));
        if (ts <= now()) ins.run(sensor.id, userId, +liters.toFixed(1), act, ts);
      };
      if (type === 'general') {
        const n = 6, day = total * (spike ? 2.0 : 1);
        for (let i = 0; i < n; i++) put(sensors[0], day / n * rand(0.8, 1.2), 'Consumo general');
      } else {
        for (const [act, loc, share] of DEMO_SHARES) {
          const s = sensors.find(x => x.loc === loc);
          if (!s) continue;
          const liters = total * share * rand(0.9, 1.1) * (spike && act === 'Ducha' ? 3.2 : 1);
          put(s, liters / 2, act); put(s, liters / 2, act);
        }
      }
    }
  });
  tx();
}

app.post('/api/onboarding', auth, (req, res) => {
  const { household, type } = req.body;
  if (!['solo', 'familia'].includes(household) || !['general', 'puntos'].includes(type))
    return fail(res, 400, 'Datos de onboarding inválidos.');
  const members = household === 'solo' ? 1 : Math.min(Math.max(parseInt(req.body.members) || 3, 2), 12);
  db.prepare(`INSERT INTO households(user_id,household,members,type) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET household=excluded.household, members=excluded.members, type=excluded.type`)
    .run(req.userId, household, members, type);

  const hasSensors = db.prepare('SELECT COUNT(*) c FROM sensors WHERE user_id=?').get(req.userId).c;
  if (!hasSensors) {
    const defs = type === 'general'
      ? [['Sensor principal', 'Tubería general']]
      : [['Cocina', 'Cocina'], ['Baño principal', 'Baño'], ['Lavadora', 'Lavandería']];
    const ins = db.prepare('INSERT INTO sensors(user_id,name,loc,api_key,created_at) VALUES(?,?,?,?,?)');
    defs.forEach(([n, l]) => ins.run(req.userId, n, l, newKey(), now()));
  }
  if (req.body.demo) seedDemo(req.userId, members, type);
  ml.invalidate(req.userId);
  res.status(201).json({ ok: true });
});

/* ---------- DASHBOARD ---------- */
function getSummary(userId) {
  const h = db.prepare('SELECT * FROM households WHERE user_id=?').get(userId);
  if (!h) return null;
  const dailyLimit = h.members * LIMIT_PER_PERSON_DAY, weeklyLimit = dailyLimit * 7;
  const since = now() - 8 * 864e5;
  const rows = db.prepare('SELECT liters, created_at FROM readings WHERE user_id=? AND created_at>=?').all(userId, since);
  const byDay = {};
  rows.forEach(r => { const k = dayKey(r.created_at); byDay[k] = (byDay[k] || 0) + r.liters; });
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const ts = now() - i * 864e5;
    let d = new Date(ts).toLocaleDateString('es', { timeZone: TZ, weekday: 'short' }).replace('.', '');
    d = d.charAt(0).toUpperCase() + d.slice(1);
    week.push({ d, l: Math.round(byDay[dayKey(ts)] || 0) });
  }
  const total = week.reduce((a, x) => a + x.l, 0);
  const diffPct = Math.round((total - weeklyLimit) / weeklyLimit * 100);
  return {
    h, dailyLimit, weeklyLimit, total, diffPct, overLimit: total > weeklyLimit, week,
    totalCost: Math.round(costL(total)), weeklyLimitCost: Math.round(costL(weeklyLimit)),   // COP al precio del m³
    excess: getExcess(userId)      // límite mensual/bimestral de la empresa y valor adicional por exceso
  };
}

app.get('/api/dashboard', auth, async (req, res) => {
  const s = getSummary(req.userId);
  if (!s) return fail(res, 400, 'Completa el onboarding primero.');
  const { h, dailyLimit, weeklyLimit, total, diffPct, overLimit, week, totalCost, weeklyLimitCost, excess } = s;

  const analysis = await ml.analyze(req.userId);
  const alerts = ml.recentAlerts(analysis, 14).slice(0, 5);

  // Recomendaciones dinámicas
  const recos = [];
  const top = db.prepare(`SELECT s.name, s.loc, SUM(r.liters) l FROM readings r JOIN sensors s ON s.id=r.sensor_id
    WHERE r.user_id=? AND r.created_at>=? GROUP BY s.id ORDER BY l DESC LIMIT 1`).get(req.userId, now() - 7 * 864e5);
  if (excess.aviso) recos.push({ t: excess.aviso.titulo, d: excess.aviso.consejo });   // límite de consumo (22 m³/mes)
  if (alerts[0]) recos.push({ t: alerts[0].titulo, d: alerts[0].consejo });   // consejo según lo que detectó el modelo
  if (overLimit) recos.push({ t: 'Reduce tu consumo esta semana', d: `Superaste el límite de ${weeklyLimit.toLocaleString('es')} L (≈ ${cop(weeklyLimitCost)}). Intenta bajar ${Math.abs(diffPct)}% para volver al rango recomendado.` });
  if (top && h.type === 'puntos') recos.push({ t: `Revisa: ${top.name}`, d: `Es tu punto de mayor consumo (${Math.round(top.l)} L en 7 días, ≈ ${cop(costL(top.l))}).` });
  recos.push(
    { t: 'Duchas de 5 minutos', d: `Reducir la ducha de 10 a 5 minutos puede ahorrar hasta 50 L por persona (≈ ${cop(costL(50))} cada día).` },
    { t: 'Cierra el grifo al enjabonar', d: 'Al lavarte los dientes o los platos, cierra la llave mientras no la uses.' },
    { t: 'Revisa fugas', d: `Un sanitario con fuga puede perder más de 100 L al día sin que lo notes (≈ ${cop(costL(100))} diarios).` },
    { t: 'Lavadora a carga completa', d: 'Lavar con carga completa aprovecha mejor cada litro de agua.' }
  );

  res.json({
    dailyLimit, weeklyLimit, total, diffPct, overLimit, week,
    precioM3: PRICE_M3, totalCost, weeklyLimitCost,      // precio asociado a toda la app (COP por m³)
    excess,                                              // límite de consumo y alerta de exceso
    activities: getActivities(req.userId, 5), recos,
    alerts,                                              // alertas del modelo (últimos 14 días)
    ml: { fuente: analysis ? analysis.fuente : 'sin_datos', modelos: analysis && analysis.modelos,
          estadisticas: analysis && analysis.estadisticas }
  });
});

/* Detalle del análisis: puntaje por día de cada modelo, alertas, estadísticas */
app.get('/api/insights', auth, async (req, res) => {
  const a = await ml.analyze(req.userId);
  if (!a) return fail(res, 400, 'Completa el onboarding primero.');
  res.json({ fuente: a.fuente, aviso: a.aviso, modelos: a.modelos, dias: a.dias, alertas: a.alertas, estadisticas: a.estadisticas });
});

app.get('/api/ml/status', auth, async (req, res) => res.json(await ml.health()));

/* ---------- CHATBOT ---------- */
app.post('/api/chat', auth, async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 500);
  if (!message) return fail(res, 400, 'Escribe un mensaje.');
  const history = (Array.isArray(req.body.history) ? req.body.history : []).slice(-10)
    .filter(m => m && ['user', 'assistant'].includes(m.role)).map(m => ({ role: m.role, content: String(m.content || '').slice(0, 1000) }));
  const summary = getSummary(req.userId);
  if (!summary) return fail(res, 400, 'Completa el onboarding primero.');
  try {
    const reply = await chatbot.reply({
      message, history, summary,
      analysis: await ml.analyze(req.userId),
      bills: bills.list(req.userId),
      sensors: db.prepare('SELECT id,name,loc FROM sensors WHERE user_id=? ORDER BY id').all(req.userId),
      user: db.prepare('SELECT name FROM users WHERE id=?').get(req.userId)
    });
    res.json({ reply });
  } catch (e) {
    console.error('chat:', e);
    fail(res, 500, 'No pude responder ahora.');
  }
});

app.get('/api/activities', auth, (req, res) => res.json(getActivities(req.userId, 50)));

/* ---------- FACTURAS ---------- */
app.use('/api/bills', bills.router({ auth, fail }));

/* ---------- SENSORES ---------- */
app.get('/api/sensors', auth, (req, res) => {
  res.json(db.prepare('SELECT id,name,loc,api_key FROM sensors WHERE user_id=? ORDER BY id').all(req.userId));
});

app.post('/api/sensors', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const loc = String(req.body.loc || '').trim();
  if (!name || !loc) return fail(res, 400, 'Nombre y ubicación son obligatorios.');
  const info = db.prepare('INSERT INTO sensors(user_id,name,loc,api_key,created_at) VALUES(?,?,?,?,?)')
    .run(req.userId, name, loc, newKey(), now());
  ml.invalidate(req.userId);
  res.status(201).json(db.prepare('SELECT id,name,loc,api_key FROM sensors WHERE id=?').get(info.lastInsertRowid));
});

app.delete('/api/sensors/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM sensors WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  if (!r.changes) return fail(res, 404, 'Sensor no encontrado.');
  ml.invalidate(req.userId);
  res.json({ ok: true });
});

/* ---------- INGESTA DE LECTURAS (lo llama el dispositivo físico) ---------- */
// POST /api/readings  Header: x-api-key: <api_key del sensor>  Body: { liters, activity?, timestamp? }
app.post('/api/readings', (req, res) => {
  const key = req.headers['x-api-key'];
  const s = key && db.prepare('SELECT id,user_id FROM sensors WHERE api_key=?').get(key);
  if (!s) return fail(res, 401, 'API key inválida.');
  const liters = Number(req.body.liters);
  if (!Number.isFinite(liters) || liters < 0 || liters > 5000) return fail(res, 400, 'Valor de litros inválido.');
  let ts = req.body.timestamp ? Number(new Date(req.body.timestamp)) : now();
  if (!Number.isFinite(ts) || ts > now() + 6e4) ts = now();
  const activity = req.body.activity ? String(req.body.activity).slice(0, 60) : null;
  db.prepare('INSERT INTO readings(sensor_id,user_id,liters,activity,created_at) VALUES(?,?,?,?,?)')
    .run(s.id, s.user_id, liters, activity, ts);
  ml.invalidate(s.user_id);   // el próximo análisis incluye la nueva lectura
  res.status(201).json({ ok: true });
});

app.use('/api', (req, res) => fail(res, 404, 'Ruta no encontrada.'));
// Errores no controlados (p. ej. en rutas async) -> JSON en vez de HTML
app.use((err, req, res, next) => { console.error(err); fail(res, 500, 'Error interno del servidor.'); });
app.listen(PORT, () => console.log(`AquaConscience en http://localhost:${PORT}`));