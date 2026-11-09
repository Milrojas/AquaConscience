require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ_APP || 'America/Bogota';
let JWT_SECRET = process.env.JWT_SECRET;


const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

console.log('Groq key cargada:', GROQ_API_KEY ? 'SÍ' : 'NO');
console.log('Modelo de Groq:', GROQ_MODEL);


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
    res.json({ ok: true });
});

/* ---------- ONBOARDING ---------- */
const ACTIVITIES = {
    'Tubería general': ['Consumo general'],
    'Cocina': ['Lavado de platos', 'Preparar comida'],
    'Baño': ['Ducha', 'Sanitario', 'Lavamanos'],
    'Lavandería': ['Lavadora'],
    'Jardín': ['Riego'],
    'Otro': ['Uso general']
};

function seedDemo(userId, dailyLimit) {
    const sensors = db.prepare('SELECT id,loc FROM sensors WHERE user_id=?').all(userId);
    if (!sensors.length) return;
    const ins = db.prepare('INSERT INTO readings(sensor_id,user_id,liters,activity,created_at) VALUES(?,?,?,?,?)');
    const tx = db.transaction(() => {
        for (let d = 6; d >= 0; d--) {
            const target = dailyLimit * rand(0.65, 1.25), n = 6;
            for (let i = 0; i < n; i++) {
                const s = sensors[Math.floor(Math.random() * sensors.length)];
                const acts = ACTIVITIES[s.loc] || ACTIVITIES['Otro'];
                const ts = now() - d * 864e5 - Math.floor(rand(0, 14) * 36e5);
                if (ts > now()) continue;
                ins.run(s.id, userId, +(target / n * rand(0.6, 1.4)).toFixed(1), acts[Math.floor(Math.random() * acts.length)], ts);
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
    if (req.body.demo) seedDemo(req.userId, members * LIMIT_PER_PERSON_DAY);
    res.status(201).json({ ok: true });
});
/* ---------- CONTEXTO PARA EL CHAT ---------- */
function getDashboardData(userId) {
    const h = db.prepare('SELECT * FROM households WHERE user_id=?').get(userId);
    if (!h) return null;
    const dailyLimit = h.members * LIMIT_PER_PERSON_DAY, weeklyLimit = dailyLimit * 7;
    const since = now() - 8 * 864e5;
    const rows = db.prepare('SELECT liters, created_at, sensor_id FROM readings WHERE user_id=? AND created_at>=?').all(userId, since);
    const byDay = {};
    rows.forEach(r => { const k = dayKey(r.created_at); byDay[k] = (byDay[k] || 0) + r.liters; });
    const week = [];
    for (let i = 6; i >= 0; i--) {
        const ts = now() - i * 864e5;
        week.push({ fecha: dayKey(ts), litros: Math.round(byDay[dayKey(ts)] || 0) });
    }
    const total = week.reduce((a, x) => a + x.litros, 0);
    const diffPct = Math.round((total - weeklyLimit) / weeklyLimit * 100);
    return { personas: h.members, limiteDiario: dailyLimit, limiteSemanal: weeklyLimit, totalSemana: total, diferenciaPorcentual: diffPct, superaLimite: total > weeklyLimit, dias: week };
}

/* ---------- HERRAMIENTAS QUE EL MODELO PUEDE LLAMAR ---------- */
const CHAT_TOOLS = [
    {
        name: 'obtener_resumen_consumo',
        description: 'Da el consumo semanal del usuario: total, límite recomendado, diferencia porcentual, y el desglose día por día.',
        parameters: { type: 'object', properties: {} }
    },
    {
        name: 'obtener_actividades_recientes',
        description: 'Da las últimas lecturas de consumo registradas (sensor, actividad, litros, fecha).',
        parameters: { type: 'object', properties: {} }
    }
];

function ejecutarHerramienta(nombre, userId) {
    if (nombre === 'obtener_resumen_consumo') return getDashboardData(userId);
    if (nombre === 'obtener_actividades_recientes') return getActivities(userId, 15);
    return { error: 'Herramienta no reconocida' };
}


/* ---------- ENDPOINT DEL CHAT ---------- */
app.post('/api/chat', auth, async (req, res) => {
    if (!GROQ_API_KEY) {
        return fail(res, 501, 'Chat no configurado (falta GROQ_API_KEY).');
    }

    const message = String(req.body.message || '').trim();
    const history = Array.isArray(req.body.history)
        ? req.body.history.slice(-10)
        : [];

    if (!message) {
        return fail(res, 400, 'Mensaje vacío.');
    }

    try {
        const u = db.prepare(
            'SELECT name FROM users WHERE id=?'
        ).get(req.userId);

        const systemPrompt =
            `Eres el asistente de AquaConscience para ${u.name}. ` +
            'Ayudas a comprender el consumo de agua del hogar y das ' +
            'consejos de ahorro concretos. ' +
            'Utiliza las herramientas disponibles para consultar datos ' +
            'reales antes de responder sobre el consumo o las actividades. ' +
            'Nunca inventes cifras ni afirmes haber consultado datos que no tienes. ' +
            'Sé breve, claro y cercano. Responde en español. ' +
            'Si preguntan algo que no esté relacionado con el agua, ' +
            'responde brevemente y redirige amablemente la conversación ' +
            'hacia el propósito de AquaConscience.';

        // Preparar el historial en el formato que espera Groq.
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history
                .filter(h =>
                    ['user', 'assistant'].includes(h.role) &&
                    typeof h.content === 'string'
                )
                .map(h => ({
                    role: h.role,
                    content: h.content
                })),
            { role: 'user', content: message }
        ];

        // Adaptar las herramientas existentes al formato de Groq.
        const tools = CHAT_TOOLS.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
            }
        }));

        let respuestaFinal = null;

        // Permitir hasta tres solicitudes para responder
        // y consultar herramientas cuando sea necesario.
        for (let intento = 0; intento < 3; intento++) {
            const r = await fetch(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${GROQ_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: GROQ_MODEL,
                        messages,
                        tools,
                        tool_choice: 'auto',
                        temperature: 0.4,
                        max_completion_tokens: 700
                    }),
                    signal: AbortSignal.timeout(45000)
                }
            );

            const data = await r.json();

            if (!r.ok) {
                console.error('Error de Groq:', data);
                throw new Error(
                    data.error?.message || 'Error al consultar Groq.'
                );
            }

            const respuesta = data.choices?.[0]?.message;

            if (!respuesta) {
                throw new Error('Groq no devolvió una respuesta válida.');
            }

            // Guardar el mensaje del modelo, incluidos sus tool_calls.
            messages.push(respuesta);

            if (respuesta.tool_calls?.length) {
                for (const llamada of respuesta.tool_calls) {
                    const nombre = llamada.function?.name;
                    const resultado = ejecutarHerramienta(
                        nombre,
                        req.userId
                    );

                    messages.push({
                        role: 'tool',
                        tool_call_id: llamada.id,
                        content: JSON.stringify(resultado)
                    });
                }

                // Volver a consultar al modelo con los datos obtenidos.
                continue;
            }

            respuestaFinal = respuesta.content;

            if (typeof respuestaFinal === 'string' &&
                respuestaFinal.trim()) {
                break;
            }
        }

        res.json({
            reply: respuestaFinal ||
                'No pude generar una respuesta. Inténtalo de nuevo.'
        });

    } catch (e) {
        console.error('Error en /api/chat:', e.message);

        const mensaje = e.name === 'TimeoutError'
            ? 'La respuesta está tardando demasiado. Inténtalo de nuevo.'
            : 'No se pudo generar la respuesta del chat. Revisa el servidor.';

        fail(res, 500, mensaje);
    }
});

/* ---------- DASHBOARD ---------- */
app.get('/api/dashboard', auth, (req, res) => {
    const h = db.prepare('SELECT * FROM households WHERE user_id=?').get(req.userId);
    if (!h) return fail(res, 400, 'Completa el onboarding primero.');
    const dailyLimit = h.members * LIMIT_PER_PERSON_DAY, weeklyLimit = dailyLimit * 7;

    const since = now() - 8 * 864e5;
    const rows = db.prepare('SELECT liters, created_at, sensor_id FROM readings WHERE user_id=? AND created_at>=?').all(req.userId, since);
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
    const overLimit = total > weeklyLimit;

    // Recomendaciones dinámicas
    const recos = [];
    const top = db.prepare(`SELECT s.name, s.loc, SUM(r.liters) l FROM readings r JOIN sensors s ON s.id=r.sensor_id
    WHERE r.user_id=? AND r.created_at>=? GROUP BY s.id ORDER BY l DESC LIMIT 1`).get(req.userId, now() - 7 * 864e5);
    if (overLimit) recos.push({ t: 'Reduce tu consumo esta semana', d: `Superaste el límite de ${weeklyLimit.toLocaleString('es')} L. Intenta bajar ${Math.abs(diffPct)}% para volver al rango recomendado.` });
    if (top && h.type === 'puntos') recos.push({ t: `Revisa: ${top.name}`, d: `Es tu punto de mayor consumo (${Math.round(top.l)} L en 7 días).` });
    recos.push(
        { t: 'Duchas de 5 minutos', d: 'Reducir la ducha de 10 a 5 minutos puede ahorrar hasta 50 L por persona.' },
        { t: 'Cierra el grifo al enjabonar', d: 'Al lavarte los dientes o los platos, cierra la llave mientras no la uses.' },
        { t: 'Revisa fugas', d: 'Un sanitario con fuga puede perder más de 100 L al día sin que lo notes.' },
        { t: 'Lavadora a carga completa', d: 'Lavar con carga completa aprovecha mejor cada litro de agua.' }
    );

    res.json({ dailyLimit, weeklyLimit, total, diffPct, overLimit, week, activities: getActivities(req.userId, 5), recos });
});

app.get('/api/activities', auth, (req, res) => res.json(getActivities(req.userId, 50)));

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
    res.status(201).json(db.prepare('SELECT id,name,loc,api_key FROM sensors WHERE id=?').get(info.lastInsertRowid));
});

app.delete('/api/sensors/:id', auth, (req, res) => {
    const r = db.prepare('DELETE FROM sensors WHERE id=? AND user_id=?').run(req.params.id, req.userId);
    if (!r.changes) return fail(res, 404, 'Sensor no encontrado.');
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
    res.status(201).json({ ok: true });
});

app.use('/api', (req, res) => fail(res, 404, 'Ruta no encontrada.'));
app.listen(PORT, () => console.log(`AquaConscience en http://localhost:${PORT}`));
