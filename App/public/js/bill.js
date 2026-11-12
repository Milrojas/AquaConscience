/* Factura del agua: precio por m³, ingreso manual, escaneo (OCR) y comparativa con los sensores.
 * Se carga ANTES de app.js: define helpers de moneda que usa toda la app. Depende de los globales
 * de app.js (state, api, esc, toast, refresh, showView), que solo se usan cuando el usuario actúa. */

const $ = id => document.getElementById(id);

/* ---------- Moneda ---------- */
const PRECIO_M3_DEFAULT = 3420.84;   // COP por m³; el valor vigente lo envía el servidor (state.precioM3)
const COP0 = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const COP2 = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cop = (n, dec = 0) => (dec ? COP2 : COP0).format(n);
const nf = (n, d = 1) => Number(n).toLocaleString('es', { maximumFractionDigits: d });
const precioM3 = () => (state && state.precioM3) || PRECIO_M3_DEFAULT;
const costOf = liters => liters / 1000 * precioM3();            // litros -> COP
const fmtDate = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const fmtShort = iso => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };

/* ---------- Escaneo: carga perezosa de las librerías (solo si el usuario escanea) ---------- */
const OCR_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const PDFJS_SRC = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const _loaded = {};
function loadScript(src) {
  return (_loaded[src] ||= new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok;
    s.onerror = () => { delete _loaded[src]; ko(new Error('No se pudo cargar el lector de facturas. Revisa tu conexión a Internet.')); };
    document.head.appendChild(s);
  }));
}

/* Foto -> canvas en escala de grises y de tamaño razonable (mejora la lectura y la velocidad) */
async function fileToCanvas(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error('No pude abrir esa imagen. Prueba con JPG, PNG o PDF.'); }
  const big = Math.max(bmp.width, bmp.height);
  const k = big < 1400 ? 1600 / big : Math.min(1, 2200 / big);
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  const ctx = cv.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.25)';
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  if (bmp.close) bmp.close();
  return cv;
}

async function ocr(canvas, setStatus) {
  await loadScript(OCR_SRC);
  const w = await Tesseract.createWorker('spa', 1, {
    logger: m => { if (m.status === 'recognizing text') setStatus(`Leyendo factura… ${Math.round(m.progress * 100)} %`); }
  });
  try { return (await w.recognize(canvas)).data.text; }
  finally { await w.terminate(); }
}

/* PDF: primero el texto incrustado; si es un PDF escaneado (sin texto) se hace OCR de las páginas */
async function pdfToText(file, setStatus) {
  await loadScript(PDFJS_SRC);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = Math.min(pdf.numPages, 3);
  let text = '';
  for (let i = 1; i <= pages; i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    text += c.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join('') + '\n';
  }
  if (text.replace(/\s/g, '').length > 80) return text;
  text = '';
  for (let i = 1; i <= pages; i++) {
    const p = await pdf.getPage(i), vp = p.getViewport({ scale: 2 });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    await p.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    text += (await ocr(cv, setStatus)) + '\n';
  }
  return text;
}

/* ---------- Interpretación del texto de la factura ---------- */
/* "85.432,00" -> 85432 · "15,5" -> 15.5 · "1.234" -> 1234 (miles) · con preferDecimal "12.345" -> 12.345 */
function numCO(s, preferDecimal) {
  s = String(s).replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  const d = s.lastIndexOf('.'), c = s.lastIndexOf(',');
  if (d >= 0 && c >= 0) {
    const dec = Math.max(d, c);
    return parseFloat(s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1));
  }
  const sep = d >= 0 ? '.' : c >= 0 ? ',' : null;
  if (!sep) return parseFloat(s);
  const parts = s.split(sep);
  if (parts.length > 2) return parseFloat(parts.join(''));
  if (parts[1].length === 3 && !preferDecimal) return parseFloat(parts.join(''));
  return parseFloat(parts[0] + '.' + parts[1]);
}

const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };
function isoDate(y, m, d) {
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function findDates(str) {
  const out = [];
  for (const m of str.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g)) out.push(isoDate(+m[3], +m[2], +m[1]));
  for (const m of str.matchAll(/\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g)) out.push(isoDate(+m[1], +m[2], +m[3]));
  for (const m of str.matchAll(/\b(\d{1,2})\s*(?:de\s*)?(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)[a-z]*\.?\s*(?:de\s*|del\s*)?(\d{2,4})\b/gi))
    out.push(isoDate(+m[3], MESES[m[2].toLowerCase()], +m[1]));
  return out.filter(Boolean).sort();
}

function parseBill(raw) {
  const t = raw.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
  const out = {};

  for (const re of [/total\s*a\s*pagar[^\d\n]{0,25}([\d.,]{3,})/i, /valor\s*total[^\d\n]{0,25}([\d.,]{3,})/i,
                    /total\s*factura[^\d\n]{0,25}([\d.,]{3,})/i, /pague\s*hasta[^\d\n]{0,25}([\d.,]{3,})/i]) {
    const m = t.match(re);
    if (m) { const v = numCO(m[1]); if (v > 0) { out.total = Math.round(v * 100) / 100; break; } }
  }

  const num = '(\\d{1,4}(?:[.,]\\d{1,2})?)';
  for (const re of [new RegExp('consumo\\s*(?:facturado|del\\s*periodo|total|mes)?[^\\d\\n]{0,25}' + num + '\\s*m\\s*[3³]', 'i'),
                    new RegExp(num + '\\s*m\\s*[3³]', 'i'),
                    new RegExp('m\\s*[3³]\\s*[:=]?\\s*' + num, 'i')]) {
    const m = t.match(re);
    if (m) { const v = numCO(m[1], true); if (v >= 0 && v <= 10000) { out.m3 = v; break; } }
  }

  const i = t.search(/per[ií]odo/i);
  if (i >= 0) {
    const d = findDates(t.slice(i, i + 140));
    if (d.length >= 2) { out.start = d[0]; out.end = d[d.length - 1]; }
  }

  const n = t.match(/(?:factura|recibo)\s*(?:de\s*(?:venta|servicios?))?\s*(?:n[o°º.]*|n[uú]mero)?\s*[:#]?\s*(\d{5,})/i);
  if (n) out.num = n[1];
  return out;
}

/* ---------- Escanear / subir ---------- */
let billSource = 'manual';

async function scanBill(inp) {
  const file = inp.files && inp.files[0];
  inp.value = '';
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) { toast('El archivo supera 15 MB'); return; }
  const st = $('bill-scan-status'), btn = document.querySelector('.scan-btn');
  const set = (msg, cls = '') => { st.textContent = msg; st.className = 'scan-status ' + cls; };
  btn.classList.add('busy');
  try {
    set('Preparando archivo…');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const text = isPdf ? await pdfToText(file, set) : await ocr(await fileToCanvas(file), set);
    const r = parseBill(text);
    if (r.start) $('bf-start').value = r.start;
    if (r.end) $('bf-end').value = r.end;
    if (r.m3 !== undefined) $('bf-m3').value = r.m3;
    if (r.total !== undefined) $('bf-total').value = r.total;
    if (r.num) $('bf-num').value = r.num;
    const found = ['start', 'end', 'm3', 'total'].filter(k => r[k] !== undefined).length;
    if (!found) set('No pude reconocer los datos de esta factura. Prueba con una foto más nítida y de frente, o ingrésalos manualmente.', 'warn');
    else if (found < 4) set(`Leí ${found} de 4 datos principales. Completa los que faltan y revisa los demás antes de guardar.`, 'warn');
    else set('Datos leídos. Revísalos y corrige lo que haga falta antes de guardar.', 'ok');
    if (found) billSource = 'scan';
  } catch (e) {
    set(e.message || 'No se pudo leer la factura. Ingresa los datos manualmente.', 'warn');
  } finally {
    btn.classList.remove('busy');
  }
}

async function saveBill() {
  const ps = $('bf-start').value, pe = $('bf-end').value;
  const m3 = parseFloat($('bf-m3').value), total = parseFloat($('bf-total').value);
  if (!ps || !pe) { toast('Indica el periodo facturado'); return; }
  if (pe < ps) { toast('La fecha final no puede ser anterior a la inicial'); return; }
  if (!(m3 >= 0)) { toast('Indica el consumo facturado en m³'); return; }
  if (!(total >= 0)) { toast('Indica el total a pagar'); return; }
  try {
    const saved = await api('/bills', 'POST', {
      period_start: ps, period_end: pe, m3, total, invoice_number: $('bf-num').value.trim() || null, source: billSource
    });
    billSel = saved.id;
    ['bf-start', 'bf-end', 'bf-m3', 'bf-total', 'bf-num'].forEach(id => { $(id).value = ''; });
    billSource = 'manual';
    $('bill-scan-status').className = 'scan-status';
    $('bill-scan-status').textContent = 'Lee el periodo, los m³ y el total. Siempre podrás corregir los datos antes de guardar.';
    await refresh();
    toast('Factura guardada');
    $('bill-compare').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { toast(e.message); }
}

async function deleteBill(id) {
  if (!confirm('¿Eliminar esta factura?')) return;
  try { await api('/bills/' + id, 'DELETE'); await refresh(); toast('Factura eliminada'); }
  catch (e) { toast(e.message); }
}

/* ---------- Render ---------- */
let billSel = null;
const ESTADO = {
  coincide: { pill: 'Coincide', cls: 'ok' },
  facturado_mayor: { pill: 'Factura mayor', cls: 'warn' },
  medido_mayor: { pill: 'Medido mayor', cls: 'warn' },
  sin_datos: { pill: 'Faltan lecturas', cls: 'info' }
};

function diffText(b) {
  const pct = b.dif_m3_pct === null ? 0 : Math.round(Math.abs(b.dif_m3_pct));
  const dif = b.dif_cop === null ? '' : cop(Math.abs(b.dif_cop));
  if (b.estado === 'coincide') return 'Tu factura refleja lo que miden tus sensores (diferencia dentro de ±10 %).';
  if (b.estado === 'facturado_mayor')
    return `Tus sensores midieron ${pct} % menos de lo que te facturaron (${dif} de diferencia). Puede deberse a cargos fijos, lecturas estimadas por la empresa o una fuga fuera de tus sensores.`;
  if (b.estado === 'medido_mayor')
    return `Tus sensores midieron ${pct} % más de lo que te facturaron (${dif} de diferencia). Puede haber consumo que aún no te cobran, o el sensor necesita calibración.`;
  return `Solo hay lecturas en ${b.dias_con_datos} de ${b.dias_periodo} días de este periodo; se necesitan al menos 3 para poder compararlo.`;
}

function compareHTML(b) {
  const e = ESTADO[b.estado], p = precioM3();
  const sm3 = b.comparado_m3 !== null ? b.comparado_m3 : b.medido_m3;
  const scost = b.comparado_cop !== null ? b.comparado_cop : b.medido_cop;
  const max = Math.max(b.facturado_m3, sm3, 0.001);
  const row = (label, m3, cost, cls) => `
    <div class="cmp-row"><div class="cmp-lbl"><span>${label}</span><b>${nf(m3)} m³ · ${cop(cost)}</b></div>
    <div class="cmp-track"><div class="cmp-fill ${cls}" style="width:${Math.max(3, m3 / max * 100)}%"></div></div></div>`;
  const facts = [];
  if (b.estimado) facts.push(`Hay lecturas en ${b.dias_con_datos} de ${b.dias_periodo} días: los sensores midieron ${nf(b.medido_m3)} m³ y la comparación usa una proyección al periodo completo.`);
  else if (b.estado === 'sin_datos') facts.push(`Los sensores midieron ${nf(b.medido_m3)} m³ en ${b.dias_con_datos} de ${b.dias_periodo} días del periodo.`);
  if (b.exceso_facturado_m3 > 0)
    facts.push(`Esta factura supera el límite de ${nf(b.limite_m3)} m³ por ${nf(b.exceso_facturado_m3)} m³: ese exceso lleva un valor adicional de ≈ ${cop(b.recargo_min)} a ${cop(b.recargo_max)}.`);
  facts.push(`Al precio asociado (${cop(p, 2)}/m³),${nf(b.facturado_m3)} m³ costarían ${cop(b.esperado_cop)}; tu factura marca ${cop(b.facturado_cop)}.`);
  if (b.precio_implicito !== null) facts.push(`Lo que pagaste en realidad por m³: ${cop(b.precio_implicito, 2)} (incluye cargos fijos y otros conceptos).`);
  return `<div class="card">
    <div class="cmp-head"><div><div class="cmp-title">${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}</div>
      <div class="cmp-sub">${b.invoice_number ? 'Factura N.º ' + esc(b.invoice_number) : 'Factura sin número'}</div></div>
      <span class="pill ${e.cls}">${e.pill}</span></div>
    ${row(b.estimado ? 'Sensores (proyectado)' : 'Sensores', sm3, scost, 'sensor')}
    ${row('Factura', b.facturado_m3, b.facturado_cop, 'factura')}
    <p class="cmp-note">${diffText(b)}</p>
    <div class="cmp-facts">${facts.map(f => `<p>${f}</p>`).join('')}</div>
  </div>`;
}

function selectBill(id) { billSel = id; renderBill(); }

function renderBill() {
  const p = precioM3(), bills = state.bills || [];
  $('bill-price').textContent = cop(p, 2) + ' / m³';
  $('bill-price-sub').textContent = `≈ ${cop(p / 1000, 2)} por litro · se aplica a todo el consumo de la app`;
  if (!bills.some(b => b.id === billSel)) billSel = bills[0] ? bills[0].id : null;
  const sel = bills.find(b => b.id === billSel);
  $('bill-compare').innerHTML = sel ? compareHTML(sel)
    : '<div class="card"><p class="muted">Registra una factura para compararla con lo que miden tus sensores.</p></div>';
  $('bill-list').innerHTML = bills.map(b => `
    <div class="sensor bill-item ${b.id === billSel ? 'sel' : ''}" onclick="selectBill(${b.id})">
      <div><div class="name">${fmtShort(b.period_start)} – ${fmtShort(b.period_end)}${b.source === 'scan' ? '<span class="tag">Escaneada</span>' : ''}</div>
      <div class="loc">${nf(b.facturado_m3)} m³ · ${cop(b.facturado_cop)}</div></div>
      <button class="iconbtn" onclick="event.stopPropagation();deleteBill(${b.id})">Eliminar</button>
    </div>`).join('') || '<p class="muted">Aún no has guardado facturas.</p>';
  renderHomeBill();
  renderLimit();
}

/* Límite de consumo (22 m³/mes · 44 m³/bimestre): alerta en Inicio y barras en la pestaña Factura */
function renderLimit() {
  const ex = state.dash && state.dash.excess, home = $('home-limit'), tab = $('bill-limit');
  if (!ex) { home.innerHTML = ''; tab.innerHTML = ''; return; }
  const a = ex.aviso;
  home.innerHTML = a ? `<div class="alert ${a.nivel === 'excedido' ? '' : 'info'} tap" onclick="showView('bill')">
    <div class="ic">${a.nivel === 'excedido' ? '🚨' : '⚠️'}</div><div><h3>${esc(a.titulo)}</h3><p>${esc(a.texto)}</p></div></div>` : '';
  const bar = (label, p) => `<div class="cmp-row"><div class="cmp-lbl"><span>${label}</span>
    <b>${nf(p.m3)} de ${nf(p.limite)} m³${p.exceso_m3 > 0 ? ' · +' + nf(p.exceso_m3) + ' m³' : ''}</b></div>
    <div class="cmp-track"><div class="cmp-fill ${p.exceso_m3 > 0 ? 'over' : 'sensor'}" style="width:${Math.max(3, Math.min(100, p.pct))}%"></div></div></div>`;
  tab.innerHTML = `<div class="card">
    <div class="cmp-head"><div><div class="cmp-title">Consumo básico de subsistencia ×2</div>
      <div class="cmp-sub">${nf(ex.limite_mes_m3)} m³ al mes · ${nf(ex.limite_bimestre_m3)} m³ al bimestre</div></div>
      <span class="pill ${a ? (a.nivel === 'excedido' ? 'warn' : 'info') : 'ok'}">${a ? (a.nivel === 'excedido' ? 'Excedido' : 'En riesgo') : 'Dentro del límite'}</span></div>
    ${bar('Este mes', ex.mes)}${bar('Este bimestre', ex.bimestre)}
    ${a ? `<p class="cmp-note">${esc(a.texto)}</p>` : ''}
    <div class="cmp-facts"><p>Cada m³ que supere el límite se cobra con un valor adicional de ≈ ${cop(ex.recargo_min)} a ${cop(ex.recargo_max)} (referencia en Bogotá). El consumo se mide con tus sensores.</p></div>
  </div>`;
}

/* Tarjeta resumen en Inicio */
function renderHomeBill() {
  const b = (state.bills || [])[0], el = $('home-bill');
  if (!b) {
    el.innerHTML = `<div class="alert info tap" onclick="showView('bill')"><div class="ic">🧾</div><div>
      <h3>Compara tu factura</h3><p>Ingresa o escanea tu factura del agua y mira si coincide con lo que miden tus sensores.</p></div></div>`;
    return;
  }
  const e = ESTADO[b.estado];
  const txt = b.estado === 'sin_datos' ? 'Aún faltan lecturas de ese periodo para compararla.'
    : `Sensores ≈ ${cop(b.comparado_cop)} · Factura ${cop(b.facturado_cop)}`;
  el.innerHTML = `<div class="alert ${e.cls} tap" onclick="showView('bill')"><div class="ic">🧾</div><div>
    <h3>Factura ${fmtShort(b.period_start)}–${fmtShort(b.period_end)}: ${e.pill}</h3><p>${txt}</p></div></div>`;
}