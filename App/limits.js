/* Límite de consumo (desincentivo por consumo excesivo).
 * Compara el consumo medido por los sensores en el mes y en el bimestre en curso (bimestres
 * calendario: ene-feb, mar-abr, …) con el límite de 22 m³/mes (44 m³/bimestre) y estima el valor
 * adicional que se cobraría por cada m³ de exceso. */
const db = require('./db');
const { LIMITE_MES_M3, LIMITE_BIMESTRE_M3, RECARGO_M3_MIN, RECARGO_M3_MAX, cop } = require('./pricing');

const TZ = process.env.TZ_APP || 'America/Bogota';
const dayKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
const MIN_DIAS_PROYECCION = 7;     // con menos días de datos no se proyecta (sería muy ruidoso)
const dim = (y, m) => new Date(y, m, 0).getDate();      // días del mes m (1-12)
const m3f = n => Number(n).toLocaleString('es', { maximumFractionDigits: 1 });
const rango = m3 => `${cop(m3 * RECARGO_M3_MIN)} – ${cop(m3 * RECARGO_M3_MAX)}`;

function periodo(nombre, etiqueta, litros, limite, transcurridos, total) {
  const m3 = litros / 1000;
  const proy = transcurridos >= MIN_DIAS_PROYECCION ? m3 / transcurridos * total : null;
  const exceso = Math.max(0, m3 - limite);
  const excesoProy = proy === null ? null : Math.max(0, proy - limite);
  return {
    nombre, etiqueta, m3, limite, pct: m3 / limite * 100, dias: transcurridos, dias_total: total,
    proyectado_m3: proy, exceso_m3: exceso, exceso_proy_m3: excesoProy,
    recargo_min: exceso * RECARGO_M3_MIN, recargo_max: exceso * RECARGO_M3_MAX
  };
}

function aviso(mes, bim) {
  const ps = [mes, bim];
  const exc = ps.find(p => p.exceso_m3 > 0);
  if (exc) return {
    nivel: 'excedido', periodo: exc.nombre,
    titulo: `Superaste el límite de consumo ${exc.etiqueta}`,
    texto: `Llevas ${m3f(exc.m3)} m³ y el límite es ${m3f(exc.limite)} m³ (el doble del consumo básico de subsistencia). ` +
      `Cada m³ adicional se cobra con un valor extra de ≈ ${cop(RECARGO_M3_MIN)} a ${cop(RECARGO_M3_MAX)}: ` +
      `por tus ${m3f(exc.exceso_m3)} m³ de exceso serían ≈ ${rango(exc.exceso_m3)} más en tu factura.`,
    consejo: 'Reduce duchas, revisa fugas y lava con carga completa para no seguir sumando exceso.'
  };
  const risk = ps.find(p => p.exceso_proy_m3 > 0);
  if (risk) return {
    nivel: 'riesgo', periodo: risk.nombre,
    titulo: `Vas camino a superar el límite ${risk.etiqueta}`,
    texto: `Llevas ${m3f(risk.m3)} m³ en ${risk.dias} de ${risk.dias_total} días; a este ritmo cerrarías en ≈ ${m3f(risk.proyectado_m3)} m³, ` +
      `sobre el límite de ${m3f(risk.limite)} m³. Ese exceso (≈ ${m3f(risk.exceso_proy_m3)} m³) tendría un valor adicional de ≈ ${rango(risk.exceso_proy_m3)}.`,
    consejo: 'Aún estás a tiempo: baja el consumo diario para quedar por debajo del límite.'
  };
  return null;
}

function getExcess(userId, nowTs = Date.now()) {
  const [Y, M, D] = dayKey(nowTs).split('-').map(Number);
  const bimM = M - ((M - 1) % 2);                        // primer mes del bimestre en curso
  const pad = n => String(n).padStart(2, '0');
  const monthStart = `${Y}-${pad(M)}-01`, bimStart = `${Y}-${pad(bimM)}-01`;
  let mes = 0, bim = 0;
  const rows = db.prepare('SELECT liters, created_at FROM readings WHERE user_id=? AND created_at>=?')
    .all(userId, nowTs - 70 * 864e5);
  for (const r of rows) {
    const k = dayKey(r.created_at);
    if (k >= monthStart) mes += r.liters;
    if (k >= bimStart) bim += r.liters;
  }
  const bimDias = dim(Y, bimM) + dim(Y, bimM + 1);
  const bimTranscurridos = (Date.UTC(Y, M - 1, D) - Date.UTC(Y, bimM - 1, 1)) / 864e5 + 1;
  const pm = periodo('mes', 'de este mes', mes, LIMITE_MES_M3, D, dim(Y, M));
  const pb = periodo('bimestre', 'de este bimestre', bim, LIMITE_BIMESTRE_M3, bimTranscurridos, bimDias);
  return {
    limite_mes_m3: LIMITE_MES_M3, limite_bimestre_m3: LIMITE_BIMESTRE_M3,
    recargo_min: RECARGO_M3_MIN, recargo_max: RECARGO_M3_MAX,
    mes: pm, bimestre: pb, aviso: aviso(pm, pb)
  };
}

module.exports = { getExcess };