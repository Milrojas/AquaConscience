/* Facturas del servicio de agua y comparativa "lo que miden los sensores" vs "lo que dice la factura".
 *
 *  GET    /api/bills       -> { precio_m3, bills:[comparativa, ...] } (la más reciente primero)
 *  POST   /api/bills       -> guarda (o actualiza, si ya existe ese periodo) una factura
 *  DELETE /api/bills/:id
 */
const express = require('express');
const db = require('./db');
const { PRICE_M3, LIMITE_MES_M3, RECARGO_M3_MIN, RECARGO_M3_MAX } = require('./pricing');

/* Límite de consumo del periodo: 22 m³ por mes (44 m³ en un bimestre). */
const limiteDelPeriodo = dias => LIMITE_MES_M3 * Math.max(1, Math.round(dias / 30.4));

const TZ = process.env.TZ_APP || 'America/Bogota';
const dayKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayN = s => Date.parse(s + 'T00:00:00Z') / 864e5;      // número de día (para restar fechas)

const TOLERANCIA_PCT = 10;     // diferencia aceptable entre lo medido y lo facturado
const COBERTURA_MIN = 0.8;     // % de días del periodo con lecturas para comparar sin proyectar
const DIAS_MIN_PROYECCION = 3; // mínimo de días con lecturas para proyectar al periodo completo

/* Compara una factura con las lecturas de los sensores dentro de su periodo. */
function compare(userId, b) {
  const diasPeriodo = dayN(b.period_end) - dayN(b.period_start) + 1;
  const lo = Date.parse(b.period_start + 'T00:00:00Z') - 864e5;
  const hi = Date.parse(b.period_end + 'T00:00:00Z') + 2 * 864e5;
  const rows = db.prepare('SELECT liters, created_at FROM readings WHERE user_id=? AND created_at BETWEEN ? AND ?')
    .all(userId, lo, hi);
  let liters = 0;
  const days = new Set();
  for (const r of rows) {
    const k = dayKey(r.created_at);
    if (k >= b.period_start && k <= b.period_end) { liters += r.liters; days.add(k); }
  }
  const cobertura = Math.min(1, days.size / diasPeriodo);
  const medidoM3 = liters / 1000;

  // Con pocos días de lecturas se proyecta al periodo completo (y se avisa en la UI)
  let comparadoM3 = null, estimado = false;
  if (cobertura >= COBERTURA_MIN) comparadoM3 = medidoM3;
  else if (days.size >= DIAS_MIN_PROYECCION) { comparadoM3 = medidoM3 / cobertura; estimado = true; }

  let difPct = null, estado = 'sin_datos';
  if (comparadoM3 !== null) {
    if (b.m3 > 0) {
      difPct = 100 * (comparadoM3 / b.m3 - 1);      // negativo: los sensores midieron menos que lo facturado
      estado = Math.abs(difPct) <= TOLERANCIA_PCT ? 'coincide' : difPct < 0 ? 'facturado_mayor' : 'medido_mayor';
    } else estado = comparadoM3 < 0.5 ? 'coincide' : 'medido_mayor';
  }
  const comparadoCop = comparadoM3 === null ? null : comparadoM3 * PRICE_M3;
  return {
    id: b.id, period_start: b.period_start, period_end: b.period_end, invoice_number: b.invoice_number,
    source: b.source, dias_periodo: diasPeriodo, dias_con_datos: days.size, cobertura, estimado,
    medido_m3: medidoM3, medido_cop: medidoM3 * PRICE_M3,
    comparado_m3: comparadoM3, comparado_cop: comparadoCop,
    facturado_m3: b.m3, facturado_cop: b.total,
    esperado_cop: b.m3 * PRICE_M3,                                  // los m³ facturados al precio asociado
    precio_implicito: b.m3 > 0 ? b.total / b.m3 : null,             // lo que realmente se pagó por m³
    dif_m3_pct: difPct,
    dif_cop: comparadoCop === null ? null : b.total - comparadoCop, // + : pagaste más de lo medido
    estado,
    // Consumo excesivo: m³ por encima del límite del periodo y valor adicional estimado
    limite_m3: limiteDelPeriodo(diasPeriodo),
    exceso_facturado_m3: Math.max(0, b.m3 - limiteDelPeriodo(diasPeriodo)),
    exceso_medido_m3: comparadoM3 === null ? null : Math.max(0, comparadoM3 - limiteDelPeriodo(diasPeriodo)),
    recargo_min: Math.max(0, b.m3 - limiteDelPeriodo(diasPeriodo)) * RECARGO_M3_MIN,
    recargo_max: Math.max(0, b.m3 - limiteDelPeriodo(diasPeriodo)) * RECARGO_M3_MAX
  };
}

const list = userId => db.prepare('SELECT * FROM bills WHERE user_id=? ORDER BY period_end DESC, id DESC')
  .all(userId).map(b => compare(userId, b));

function clean(b) {
  const ps = String(b.period_start || ''), pe = String(b.period_end || '');
  if (!DATE.test(ps) || !DATE.test(pe) || isNaN(Date.parse(ps)) || isNaN(Date.parse(pe)))
    return { error: 'Fechas del periodo inválidas.' };
  if (pe < ps) return { error: 'La fecha final no puede ser anterior a la inicial.' };
  if (dayN(pe) - dayN(ps) > 400) return { error: 'El periodo no puede superar 400 días.' };
  const m3 = Number(b.m3), total = Number(b.total);
  if (!Number.isFinite(m3) || m3 < 0 || m3 > 10000) return { error: 'Consumo facturado (m³) inválido.' };
  if (!Number.isFinite(total) || total < 0 || total > 1e9) return { error: 'Valor total de la factura inválido.' };
  const inv = b.invoice_number ? String(b.invoice_number).trim().slice(0, 40) : null;
  return { ps, pe, m3, total, inv: inv || null, source: b.source === 'scan' ? 'scan' : 'manual' };
}

function router({ auth, fail }) {
  const r = express.Router();
  r.use(auth);

  r.get('/', (req, res) => res.json({ precio_m3: PRICE_M3, bills: list(req.userId) }));

  r.post('/', (req, res) => {
    const v = clean(req.body || {});
    if (v.error) return fail(res, 400, v.error);
    db.prepare(`INSERT INTO bills(user_id,period_start,period_end,m3,total,invoice_number,source,created_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,period_start,period_end) DO UPDATE SET
        m3=excluded.m3, total=excluded.total, invoice_number=excluded.invoice_number, source=excluded.source`)
      .run(req.userId, v.ps, v.pe, v.m3, v.total, v.inv, v.source, Date.now());
    const row = db.prepare('SELECT * FROM bills WHERE user_id=? AND period_start=? AND period_end=?')
      .get(req.userId, v.ps, v.pe);
    res.status(201).json(compare(req.userId, row));
  });

  r.delete('/:id', (req, res) => {
    const x = db.prepare('DELETE FROM bills WHERE id=? AND user_id=?').run(req.params.id, req.userId);
    if (!x.changes) return fail(res, 404, 'Factura no encontrada.');
    res.json({ ok: true });
  });
  return r;
}

module.exports = { router, list, compare };