/* Asistente de AquaConscience: responde con los datos reales del usuario
 * (consumo, sensores, facturas) y con lo que detecta el modelo de ML (alertas, actividades,
 * comparación con hogares de referencia). No usa un LLM externo: son intenciones
 * por palabras clave, fáciles de ampliar en INTENTS.
 */
const { refStats, recentAlerts, CONSEJOS, NOMBRES } = require('./ml');
const { PRICE_M3, costL, cop } = require('./pricing');

const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const has = (t, ...w) => w.some(x => t.includes(x));
const L = n => Math.round(n).toLocaleString('es');
const M3 = n => Number(n).toLocaleString('es', { maximumFractionDigits: 1 });
const fecha = iso => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
const pct = n => `${n > 0 ? '+' : ''}${Math.round(n)} %`;

const AHORRO_GENERAL = [
  `Duchas de 5 minutos: pasar de 10 a 5 minutos puede ahorrar hasta 50 L por persona (≈ ${cop(costL(50))} al día).`,
  'Cierra la llave al enjabonar los platos o cepillarte los dientes.',
  'Lava la ropa con carga completa.'
];

/* Consumo medio por persona y actividad en los últimos 7 días completos vs. lo típico del dataset. */
function perfilCategorias(an) {
  if (!an || !an.serie.dias.length) return null;
  const ref = refStats(), dias = an.serie.dias.slice(-7), P = an.serie.personas, tot = {};
  dias.forEach(d => Object.entries(d.categorias || {}).forEach(([c, v]) => (tot[c] = (tot[c] || 0) + v)));
  const cats = Object.keys(tot);
  if (!cats.length) return null;
  return cats.map(c => {
    const lpp = tot[c] / P / dias.length, tip = ref && ref.medianas[c];
    return { c, lpp, tip, ratio: tip ? lpp / tip : null };
  }).sort((a, b) => b.lpp - a.lpp);
}

const sinHistorial = an => an && an.modelos.general && !an.modelos.general.ok
  ? an.modelos.general.motivo : null;
const notaFuente = an => an && an.fuente === 'reglas'
  ? '\n(Nota: el modelo de ML no está disponible ahora; usé una regla simple basada en tu promedio.)' : '';

/* ---------- Intenciones ---------- */
const INTENTS = [
  { name: 'saludo', test: (t) => t.length < 25 && has(t, 'hola', 'buenas', 'buenos dias', 'buenas tardes', 'hey'),
    run: c => `Hola, ${c.nombre}. Puedo contarte cómo va tu consumo, cuánto cuesta, si tu factura coincide con lo que miden tus sensores y darte consejos para ahorrar. ¿Qué quieres saber?` },

  { name: 'gracias', test: t => has(t, 'gracias', 'thank'),
    run: () => 'Con gusto. Si quieres, puedo revisar si hubo consumos inusuales o darte consejos para ahorrar.' },

  { name: 'afirmar', test: (t, c) => /^(si|claro|dale|ok|okay|por favor|quiero|listo)\b/.test(t) && /ideas|consejos/.test(norm(c.ultimoBot)),
    run: c => tips(c) },

  { name: 'limite', test: t => has(t, 'exceso', 'excesivo', 'recargo', 'sobrecosto', 'cargo adicional', 'valor adicional', 'subsistencia', 'bimestre', 'desincentivo', 'limite de consumo', 'limite mensual', 'cuanto me falta'),
    run: c => limite(c) },

  { name: 'factura', test: t => has(t, 'factura', 'recibo', 'cobro', 'cobran', 'precio', 'tarifa', 'costo', 'cuesta', 'cuanto pago', 'cuanto pague', 'pesos', 'metro cubico', 'm3', 'm³'),
    run: (c, t) => factura(c, t) },

  { name: 'anomalias', test: t => has(t, 'raro', 'anormal', 'anomal', 'alerta', 'pico', 'inusual', 'disparo', 'disparado', 'sospech', 'algo mal'),
    run: c => anomalias(c) },

  { name: 'fuga', test: t => has(t, 'fuga', 'gotea', 'goteo', 'se sale el agua'),
    run: c => fuga(c) },

  { name: 'comparar', test: t => has(t, 'compar', 'otros hogares', 'similares', 'vecinos', 'promedio de otros', 'estoy bien', 'normal'),
    run: c => comparar(c) },

  { name: 'ahorro', test: t => has(t, 'ahorr', 'consejo', 'tip', 'recomend', 'reduc', 'bajar', 'mejorar', 'gastar menos'),
    run: c => tips(c) },

  { name: 'donde', test: t => has(t, 'donde gasto', 'en que gasto', 'que gasta', 'mas gasto', 'actividad', 'ducha', 'cocina', 'lavadora', 'inodoro', 'sanitario', 'bano', 'lavar'),
    run: c => donde(c) },

  { name: 'hoyayer', test: t => has(t, 'hoy', 'ayer'),
    run: c => hoyAyer(c) },

  { name: 'semana', test: t => has(t, 'semana', 'consumo', 'como voy', 'limite', 'total', 'cuanto', 'litros'),
    run: c => semana(c) },

  { name: 'sensores', test: t => has(t, 'sensor', 'dispositivo', 'api key', 'instalar'),
    run: c => `Tienes ${c.sensors.length} sensor(es): ${c.sensors.map(s => `${s.name} (${s.loc})`).join(', ') || 'ninguno'}. ` +
      'Puedes agregar o quitar sensores en la pestaña Perfil.' }
];

/* ---------- Respuestas ---------- */
function semana(c) {
  const s = c.summary, rel = s.diffPct <= 0
    ? `${Math.abs(s.diffPct)}% por debajo` : `${s.diffPct}% por encima`;
  let r = `Esta semana llevas ${L(s.total)} L (≈ ${cop(s.totalCost)}), ${rel} de tu límite recomendado (${L(s.weeklyLimit)} L ≈ ${cop(s.weeklyLimitCost)} para ${s.h.members} persona(s)).`;
  if (s.excess && s.excess.aviso) r += `\n⚠️ ${s.excess.aviso.titulo}: pregúntame "¿cuánto es el recargo por exceso?" para ver el detalle.`;
  const n = recentAlerts(c.an, 7).length;
  if (n) r += `\nEl modelo detectó ${n} día(s) con consumo inusual esta semana. Pregúntame "¿hubo algo raro?" para ver el detalle.`;
  else if (s.overLimit) r += '\nSi quieres, te doy ideas para bajarlo.';
  return r;
}

/* Límite de consumo de la empresa: 22 m³/mes (44 m³/bimestre) y valor adicional por exceso. */
function limite(c) {
  const e = c.summary.excess;
  if (!e) return 'Aún no tengo datos para calcular tu límite de consumo.';
  const f = n => M3(n);
  let r = `El límite de consumo es el doble del consumo básico de subsistencia: ${f(e.limite_mes_m3)} m³ al mes (${f(e.limite_bimestre_m3)} m³ al bimestre). ` +
    `Por cada m³ que lo supere se cobra un valor adicional de ≈ ${cop(e.recargo_min)} a ${cop(e.recargo_max)}.\n` +
    `Este mes llevas ${f(e.mes.m3)} m³ (${Math.round(e.mes.pct)} % del límite) y en el bimestre ${f(e.bimestre.m3)} m³ (${Math.round(e.bimestre.pct)} %).`;
  if (e.aviso) r += `\n\n${e.aviso.titulo}. ${e.aviso.texto}\n${e.aviso.consejo}`;
  else r += '\nVas dentro del límite. Sigue así.';
  return r;
}

/* Costo del consumo al precio por m³ y comparación con la última factura registrada. */
function factura(c, t) {
  const s = c.summary, precio = `${cop(PRICE_M3, 2)} por m³`;
  const soloPrecio = has(t, 'precio', 'tarifa', 'metro cubico', 'm3', 'm³') && !has(t, 'factura', 'recibo');
  if (soloPrecio)
    return `El agua está asociada a ${precio} (${cop(PRICE_M3 / 1000, 2)} por litro). Con ese precio, tu consumo de esta semana (${L(s.total)} L) cuesta ≈ ${cop(s.totalCost)}.`;

  const costo = `Al precio asociado (${precio}), tu consumo de esta semana (${L(s.total)} L) cuesta ≈ ${cop(s.totalCost)}.`;
  const b = (c.bills || [])[0];
  if (!b) return costo + '\nAún no has registrado una factura: en la pestaña Factura puedes ingresarla o escanearla para compararla con lo que miden tus sensores.';

  const periodo = `${fecha(b.period_start)} al ${fecha(b.period_end)}`;
  const cab = `Tu factura del ${periodo} es de ${cop(b.facturado_cop)} por ${M3(b.facturado_m3)} m³.`;
  if (b.estado === 'sin_datos')
    return `${cab}\nTus sensores solo tienen lecturas en ${b.dias_con_datos} de ${b.dias_periodo} días de ese periodo, así que todavía no puedo compararla.`;

  let r = `${cab}\nTus sensores midieron ${M3(b.medido_m3)} m³` +
    (b.estimado ? ` en ${b.dias_con_datos} de ${b.dias_periodo} días (proyectado al periodo completo: ≈ ${M3(b.comparado_m3)} m³)` : '') +
    `, equivalentes a ≈ ${cop(b.comparado_cop)}.`;
  const dif = Math.abs(b.dif_m3_pct === null ? 0 : b.dif_m3_pct);
  if (b.estado === 'coincide') r += '\nCoinciden (diferencia dentro de ±10 %): tu factura refleja tu consumo.';
  else if (b.estado === 'facturado_mayor')
    r += `\nTe facturaron más de lo que miden tus sensores: ${Math.round(dif)} % menos medido (${cop(Math.abs(b.dif_cop))} de diferencia). ` +
      'Puede deberse a cargos fijos, lecturas estimadas por la empresa o una fuga fuera de tus sensores. Revisa llaves y tanques.';
  else
    r += `\nTus sensores midieron ${Math.round(dif)} % más de lo facturado (${cop(Math.abs(b.dif_cop))} de diferencia). ` +
      'Puede haber consumo no facturado todavía, o el sensor necesita calibración.';
  if (b.estimado) r += '\n(Es una estimación: con lecturas de todo el periodo la comparación será más precisa.)';
  return r;
}

function anomalias(c) {
  const falta = sinHistorial(c.an);
  const alertas = recentAlerts(c.an, 14);
  if (!alertas.length) {
    if (falta) return `Todavía no puedo comparar tu consumo con tu historial. ${falta}`;
    return 'No encontré días con consumo anormal en los últimos 14 días. Sigue así.' + notaFuente(c.an);
  }
  const lista = alertas.slice(0, 3).map(a => `• ${a.titulo}: ${a.texto}`).join('\n');
  const mas = alertas.length > 3 ? `\n(y ${alertas.length - 3} más)` : '';
  return `Esto es lo que detecté en los últimos 14 días:\n${lista}${mas}\n\nSugerencia: ${alertas[0].consejo}` + notaFuente(c.an);
}

function fuga(c) {
  const perfil = perfilCategorias(c.an), ino = perfil && perfil.find(p => p.c === 'inodoro');
  const alertaIno = recentAlerts(c.an, 14).find(a => a.categoria === 'inodoro');
  let r = '';
  if (alertaIno) r += `El modelo marcó un exceso en el inodoro: ${alertaIno.texto}\n`;
  else if (ino && ino.ratio > 1.4) r += `Tu consumo en inodoro (${ino.lpp.toFixed(0)} L por persona al día) está ${pct(100 * (ino.ratio - 1))} sobre lo típico (${ino.tip.toFixed(0)} L), lo que puede indicar una fuga.\n`;
  else return 'No veo señales claras de fuga en tus datos recientes (el modelo solo detecta consumos altos o inusuales). ' +
    'Para comprobarlo en casa: echa colorante en el tanque del inodoro; si aparece en la taza sin descargar, hay fuga.';
  return r + CONSEJOS.inodoro;
}

function comparar(c) {
  const e = c.an && c.an.estadisticas;
  if (!e) return 'Aún no tengo días completos de lecturas para compararte. Vuelve a preguntarme mañana.';
  let r = `En tus últimos ${e.dias_considerados} días completos consumiste ${e.litros_por_persona_dia} L por persona al día.`;
  if (e.similares) {
    const dif = 100 * (e.litros_por_persona_dia / e.similares.lpp - 1), s = e.similares;
    r += `\nLos hogares de referencia de ${s.personas} persona(s) (${s.n_hogares} hogares) promedian ${s.lpp.toFixed(1)} L: estás ${Math.abs(Math.round(dif))}% ${dif <= 0 ? 'por debajo' : 'por encima'}.`;
    if (!s.exacto) r += ' (Es la referencia más cercana a tu número de personas.)';
  }
  if (e.cambio_vs_semana_anterior_pct !== null)
    r += `\nVs. la semana anterior: ${pct(e.cambio_vs_semana_anterior_pct)}.`;
  return r + '\nComo referencia general, ~100 L por persona al día es lo recomendado.';
}

function donde(c) {
  const perfil = perfilCategorias(c.an);
  if (!perfil) return 'Tu sensor mide solo el consumo total del hogar. Con sensores por punto (cocina, baño, lavandería) o actividades reportadas podría decirte dónde gastas más.';
  const lineas = perfil.slice(0, 4).map(p =>
    `• ${NOMBRES[p.c] || p.c}: ${p.lpp.toFixed(1)} L por persona al día` + (p.tip ? ` (típico ${p.tip.toFixed(1)} L)` : ''));
  const alto = perfil.filter(p => p.ratio).sort((a, b) => b.ratio - a.ratio)[0];
  let r = 'Tu consumo por actividad en los últimos 7 días completos:\n' + lineas.join('\n');
  if (alto && alto.ratio >= 1.25) r += `\n\nLo que más se aleja de lo típico es ${NOMBRES[alto.c]} (${pct(100 * (alto.ratio - 1))}). ${CONSEJOS[alto.c]}`;
  else r += '\n\nNada se aleja mucho de lo típico.';
  return r;
}

function hoyAyer(c) {
  const w = c.summary.week, hoy = w[w.length - 1], ayer = w[w.length - 2], lim = c.summary.dailyLimit;
  return `Hoy llevas ${L(hoy.l)} L (≈ ${cop(costL(hoy.l))}; el día aún no termina). Ayer consumiste ${L(ayer.l)} L (≈ ${cop(costL(ayer.l))}), ${ayer.l > lim ? 'por encima' : 'dentro'} de tu límite diario de ${L(lim)} L.`;
}

function tips(c) {
  const perfil = perfilCategorias(c.an), alto = perfil && perfil.filter(p => p.ratio).sort((a, b) => b.ratio - a.ratio)[0];
  const lineas = [];
  if (alto && alto.ratio >= 1.25) lineas.push(`Prioridad: ${NOMBRES[alto.c]} (${pct(100 * (alto.ratio - 1))} sobre lo típico). ${CONSEJOS[alto.c]}`);
  else if (c.summary.overLimit) lineas.push(`Superaste tu límite semanal por ${c.summary.diffPct}%: empieza por las duchas y la llave abierta mientras enjabonas.`);
  AHORRO_GENERAL.forEach(t => lineas.push(t));
  return 'Estos consejos aplican a tu hogar:\n' + lineas.slice(0, 4).map(t => `• ${t}`).join('\n');
}

/* ---------- Entrada principal ---------- */
async function reply({ message, history = [], summary, analysis, bills = [], sensors, user }) {
  const t = norm(message).trim();
  const ultimoBot = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
  const ctx = { summary, an: analysis, bills, sensors, nombre: user.name.split(' ')[0], ultimoBot };
  for (const it of INTENTS) if (it.test(t, ctx)) return it.run(ctx, t);
  return 'Puedo ayudarte con tu consumo semanal y su costo, si tu factura coincide con lo medido, días de consumo inusual detectados por el modelo, en qué actividades gastas más, cómo te comparas con otros hogares y consejos para ahorrar. ¿Cuál te interesa?';
}

module.exports = { reply };