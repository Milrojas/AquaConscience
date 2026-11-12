let state = null;
const TOKEN_KEY = 'aq_token';

/* ---------- API ---------- */
async function api(path, method='GET', body){
  const headers = {'Content-Type':'application/json'};
  const t = localStorage.getItem(TOKEN_KEY);
  if(t) headers.Authorization = 'Bearer '+t;
  let res;
  try{
    res = await fetch('/api'+path, {method, headers, body: body? JSON.stringify(body): undefined});
  }catch(e){ throw new Error('No se pudo conectar con el servidor.'); }
  const data = await res.json().catch(()=>({}));
  if(!res.ok){
    const err = new Error(data.error || 'Error inesperado');
    err.status = res.status;
    throw err;
  }
  return data;
}
function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1800); }

/* ---------- AUTH ---------- */
function setAuthTab(t){
  document.getElementById('tab-login').classList.toggle('on', t==='login');
  document.getElementById('tab-signup').classList.toggle('on', t==='signup');
  document.getElementById('form-login').style.display = t==='login'?'block':'none';
  document.getElementById('form-signup').style.display = t==='signup'?'block':'none';
  document.getElementById('auth-err').style.display='none';
}
function showErr(msg){ const e=document.getElementById('auth-err'); e.textContent=msg; e.style.display='block'; }

async function doLogin(){
  const email=document.getElementById('li-email').value.trim();
  const password=document.getElementById('li-pass').value;
  if(!email||!password){ showErr('Ingresa tu correo y contraseña.'); return; }
  try{
    const r = await api('/auth/login','POST',{email,password});
    localStorage.setItem(TOKEN_KEY, r.token);
    await enterApp();
  }catch(e){ showErr(e.message); }
}
async function doSignup(){
  const name=document.getElementById('su-name').value.trim();
  const email=document.getElementById('su-email').value.trim();
  const password=document.getElementById('su-pass').value;
  if(!name||!email||password.length<6){ showErr('Completa todos los campos (contraseña de 6+ caracteres).'); return; }
  try{
    const r = await api('/auth/signup','POST',{name,email,password});
    localStorage.setItem(TOKEN_KEY, r.token);
    showOnboarding();
  }catch(e){ showErr(e.message); }
}
function showOnboarding(){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-onboarding').classList.add('active');
}

/* ---------- ONBOARDING ---------- */
let obHousehold=null, obType=null;
function selectHousehold(v, el){
  obHousehold=v;
  document.querySelectorAll('#ob-step1 .optcard').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel');
  document.getElementById('members-wrap').style.display = v==='familia'?'block':'none';
}
function goStep2(){
  if(!obHousehold){ toast('Selecciona una opción'); return; }
  document.getElementById('ob-step1').style.display='none';
  document.getElementById('ob-step2').style.display='block';
}
function backStep1(){
  document.getElementById('ob-step2').style.display='none';
  document.getElementById('ob-step1').style.display='block';
}
function selectType(v, el){
  obType=v;
  document.querySelectorAll('#ob-step2 .optcard').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel');
}
async function finishOnboarding(){
  if(!obType){ toast('Selecciona el tipo de instalación'); return; }
  const members = obHousehold==='solo' ? 1 : (parseInt(document.getElementById('ob-members').value)||3);
  try{
    // demo:true genera 21 días de lecturas de ejemplo; quítalo cuando uses sensores reales
    await api('/onboarding','POST',{household:obHousehold, members, type:obType, demo:true});
    await enterApp();
  }catch(e){ toast(e.message); }
}

/* ---------- CARGA DE DATOS ---------- */
async function loadState(){
  const me = await api('/me');
  if(!me.onboarded) return {me, onboarded:false};
  const [dash, sensors, activities, bills] = await Promise.all([
    api('/dashboard'), api('/sensors'), api('/activities'), api('/bills')
  ]);
  return {me, onboarded:true, dash, sensors, activities, bills};
}
function buildState(s){
  return {
    user: s.me.user, household: s.me.household.household, members: s.me.household.members,
    type: s.me.household.type, dailyLimit: s.dash.dailyLimit, weeklyLimit: s.dash.weeklyLimit,
    precioM3: s.dash.precioM3,                       // COP por m³ (se aplica a toda la app)
    dash: s.dash, sensors: s.sensors, activities: s.activities, bills: s.bills.bills
  };
}
async function enterApp(){
  try{
    const s = await loadState();
    if(!s.onboarded){ showOnboarding(); return; }
    state = buildState(s);
    goApp();
  }catch(e){
    if(e.status===401){ localStorage.removeItem(TOKEN_KEY); logout(); }
    else showErr(e.message);
  }
}
async function refresh(){
  state = buildState(await loadState());
  renderAll();
}

/* ---------- APP RENDER ---------- */
function goApp(){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-app').classList.add('active');
  renderAll();
}
function initials(name){ return (name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase(); }

function renderAll(){
  const u=state.user, d=state.dash;
  document.getElementById('app-name').textContent = u.name.split(' ')[0];
  document.getElementById('app-avatar').textContent = initials(u.name);
  document.getElementById('pf-avatar').textContent = initials(u.name);
  document.getElementById('pf-name').textContent = u.name;
  document.getElementById('pf-sub').textContent = (state.household==='solo'?'Hogar unipersonal':'Núcleo familiar · '+state.members+' personas') + ' · ' + u.email;

  document.getElementById('home-total').textContent = d.total.toLocaleString('es')+' L';
  document.getElementById('home-cost').textContent =
    `≈ ${cop(costOf(d.total))} · límite ≈ ${cop(costOf(state.weeklyLimit))} (${cop(state.precioM3,2)}/m³)`;
  document.getElementById('home-vs').textContent = d.diffPct<=0
    ? `${Math.abs(d.diffPct)}% por debajo del límite recomendado`
    : `${d.diffPct}% por encima del límite recomendado`;

  const maxL = Math.max(...d.week.map(x=>x.l), state.dailyLimit);
  document.getElementById('home-bars').innerHTML = d.week.map(x=>{
    const h = Math.max(6, Math.round(x.l/maxL*90));
    const over = x.l>state.dailyLimit;
    return `<div class="bar-col" title="${esc(x.d)}: ${x.l} L · ${cop(costOf(x.l))}"><div class="bar ${over?'over':''}" style="height:${h}px"></div><span>${x.d}</span></div>`;
  }).join('');

  // Alertas del modelo de ML (días con consumo inusual) + alerta de límite semanal
  const mlAlerts = (d.alerts||[]).slice(0,2).map(a=>`
    <div class="alert"><div class="ic">🔎</div><div>
      <h3>${esc(a.titulo)}</h3>
      <p>${esc(a.texto)}</p>
    </div></div>`).join('');
  document.getElementById('home-alert').innerHTML = limitAlertHTML(d.excess) + mlAlerts + (d.overLimit ? `
    <div class="alert"><div class="ic">⚠️</div><div>
      <h3>Consumo por encima del límite</h3>
      <p>Superaste tu límite semanal recomendado (${state.weeklyLimit.toLocaleString('es')} L ≈ ${cop(costOf(state.weeklyLimit))}). Pregúntale al Asistente cómo reducirlo.</p>
    </div></div>` : '');

  const rows = list => list.map(a=>{
    const over = a.l > state.dailyLimit*0.3;
    return `<div class="actrow"><div><div class="who">${esc(a.who)}</div><div class="meta">${esc(a.t)}</div></div>
      <div class="rightcol"><div class="lit ${over?'over':''}">${a.l} L</div><div class="cop">${cop(costOf(a.l))}</div></div></div>`;
  }).join('');
  const empty = '<p style="font-size:13px;color:#5A716C;">Aún no hay actividad registrada.</p>';
  document.getElementById('home-activity').innerHTML = rows(d.activities) || empty;
  document.getElementById('activity-list').innerHTML = rows(state.activities) || empty;

  renderBill();   // pestaña Factura + tarjeta de Inicio (bill.js)
  initChat();

  document.getElementById('sensor-list').innerHTML = state.sensors.map(s=>`
    <div class="sensor"><div><div class="name">${esc(s.name)}</div><div class="loc">${esc(s.loc)}</div></div>
    <button class="iconbtn" onclick="removeSensor(${s.id})">Eliminar</button></div>`).join('') ||
    '<p style="font-size:13px;color:#5A716C;">No tienes sensores registrados.</p>';
}

/* Límite de consumo de la empresa (22 m³/mes · 44 m³/bimestre) y valor adicional por exceso.
   d.excess lo calcula el servidor (limits.js). Si hay exceso o riesgo, muestra la alerta; si no, solo el avance. */
function limitAlertHTML(e){
  if(!e) return '';
  const m3 = n => Number(n).toLocaleString('es',{maximumFractionDigits:1});
  const bar = (p, etiqueta) => {
    const pct = Math.min(100, Math.round(p.pct));
    const cls = p.exceso_m3>0 ? 'over' : (p.exceso_proy_m3>0 ? 'risk' : '');
    return `<div class="lim-row"><div class="lim-lbl"><span>${etiqueta}</span><b>${m3(p.m3)} / ${m3(p.limite)} m³</b></div>
      <div class="lim-track"><div class="lim-fill ${cls}" style="width:${Math.max(2,pct)}%"></div></div></div>`;
  };
  const a = e.aviso;
  const alerta = a ? `<div class="alert ${a.nivel==='excedido'?'danger':''}"><div class="ic">${a.nivel==='excedido'?'🚨':'⚠️'}</div><div>
      <h3>${esc(a.titulo)}</h3><p>${esc(a.texto)}</p><p style="margin-top:6px;">${esc(a.consejo)}</p></div></div>` : '';
  return alerta + `<div class="card lim-card"><div class="lim-title">Límite de consumo</div>
    ${bar(e.mes,'Este mes')}${bar(e.bimestre,'Este bimestre')}
    <p class="lim-note">Pasar el doble del consumo básico (${m3(e.limite_mes_m3)} m³/mes · ${m3(e.limite_bimestre_m3)} m³/bimestre) suma un valor adicional de ≈ ${cop(e.recargo_min)} a ${cop(e.recargo_max)} por cada m³ extra.</p></div>`;
}

/* ---------- NAV ---------- */
function showView(v){
  ['home','activity','bill','reco','profile'].forEach(n=>{
    document.getElementById('view-'+n).classList.toggle('active', n===v);
    document.getElementById('nav-'+n).classList.toggle('on', n===v);
  });
  if(v==='reco') chatScroll();
  window.scrollTo({top:0});
}

/* ---------- PROFILE ---------- */
function openEditProfile(){
  document.getElementById('ep-name').value=state.user.name;
  document.getElementById('ep-email').value=state.user.email;
  document.getElementById('ep-household').value=state.household;
  document.getElementById('ep-members').value=state.members;
  document.getElementById('modal-profile').classList.add('open');
}
async function saveProfile(){
  try{
    await api('/me','PUT',{
      name: document.getElementById('ep-name').value.trim(),
      email: document.getElementById('ep-email').value.trim(),
      household: document.getElementById('ep-household').value,
      members: parseInt(document.getElementById('ep-members').value)||1
    });
    closeModal('modal-profile'); await refresh(); toast('Perfil actualizado');
  }catch(e){ toast(e.message); }
}
function closeModal(id){ document.getElementById(id).classList.remove('open'); }

/* ---------- SENSORS ---------- */
function openAddSensor(){ document.getElementById('as-name').value=''; document.getElementById('modal-sensor').classList.add('open'); }
async function addSensor(){
  const name=document.getElementById('as-name').value.trim();
  const loc=document.getElementById('as-loc').value;
  if(!name){ toast('Escribe un nombre para el sensor'); return; }
  try{
    await api('/sensors','POST',{name, loc});
    closeModal('modal-sensor'); await refresh(); toast('Sensor registrado');
  }catch(e){ toast(e.message); }
}
async function removeSensor(id){
  try{ await api('/sensors/'+id,'DELETE'); await refresh(); toast('Sensor eliminado'); }
  catch(e){ toast(e.message); }
}

function logout(){
  localStorage.removeItem(TOKEN_KEY);
  state = null;
  resetChat();
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-auth').classList.add('active');
  document.getElementById('li-email').value=''; document.getElementById('li-pass').value='';
}

/* ---------- CHATBOT ---------- */
let chatHistory = [];      // [{role:'user'|'assistant', content:'...'}]
let chatReady = false;
let chatBusy = false;

function chatScroll(){
  const box = document.getElementById('chat-msgs');
  if(box) box.scrollTop = box.scrollHeight;
}
function addMsg(role, text, extraClass){
  const box = document.getElementById('chat-msgs');
  const el = document.createElement('div');
  el.className = 'msg ' + (role==='user' ? 'user' : 'bot') + (extraClass ? ' '+extraClass : '');
  el.innerHTML = esc(text).replace(/\n/g,'<br>');
  box.appendChild(el);
  chatScroll();
  return el;
}
function setChips(list){
  document.getElementById('chat-chips').innerHTML = list.map(t=>
    `<button class="chip" onclick="sendChat(this.dataset.q)" data-q="${esc(t)}">${esc(t)}</button>`).join('');
}
function initChat(){
  if(chatReady) return;
  chatReady = true;
  const name = state.user.name.split(' ')[0];
  addMsg('bot', `Hola, ${name}. Soy tu asistente de AquaConscience. Puedo explicarte tu consumo y cuánto cuesta, revisar si tu factura coincide con lo que miden tus sensores y darte consejos para ahorrar agua. ¿Qué quieres saber?`);
  setChips(['¿Cómo voy esta semana?', '¿Mi factura coincide con lo medido?', '¿Cuánto cuesta mi consumo?', '¿Hubo consumos anormales?', '¿Dónde gasto más?', '¿Cómo me comparo con otros hogares?', '¿Cómo ahorro agua?']);
  document.getElementById('chat-text').addEventListener('keydown', e=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendChat(); }
  });
}
function resetChat(){
  chatHistory = []; chatReady = false; chatBusy = false;
  const m = document.getElementById('chat-msgs'); if(m) m.innerHTML = '';
  const c = document.getElementById('chat-chips'); if(c) c.innerHTML = '';
}

async function sendChat(preset){
  if(chatBusy) return;
  const input = document.getElementById('chat-text');
  const text = (typeof preset === 'string' ? preset : input.value).trim();
  if(!text) return;
  input.value = '';
  document.getElementById('chat-chips').innerHTML = '';   // las sugerencias solo se muestran al inicio
  addMsg('user', text);
  chatHistory.push({role:'user', content:text});

  chatBusy = true;
  document.getElementById('chat-send').disabled = true;
  const typing = document.createElement('div');
  typing.className = 'msg bot typing';
  typing.innerHTML = '<i></i><i></i><i></i>';
  document.getElementById('chat-msgs').appendChild(typing);
  chatScroll();

  try{
    const reply = await askBot(text);
    typing.remove();
    addMsg('bot', reply);
    chatHistory.push({role:'assistant', content:reply});
  }catch(e){
    typing.remove();
    if(e.status===401){ localStorage.removeItem(TOKEN_KEY); logout(); return; }
    addMsg('bot', 'No pude responder ahora. Intenta de nuevo en un momento.', 'err');
  }finally{
    chatBusy = false;
    document.getElementById('chat-send').disabled = false;
    input.focus({preventScroll:true});
  }
}

/* Punto de conexión con el backend.
   POST /api/chat  {message, history}  ->  {reply: "texto"}
   El backend responde con los datos reales del usuario, su factura y las alertas del modelo de ML.
   Si no hay conexión (o el endpoint no existe: 404/501), responde con reglas
   locales para que la UI siga funcionando. */
async function askBot(message){
  try{
    const r = await api('/chat','POST',{message, history: chatHistory.slice(-10)});
    if(typeof r.reply === 'string' && r.reply) return r.reply;
    throw new Error('Respuesta vacía');
  }catch(e){
    if(!e.status || e.status===404 || e.status===501){
      await new Promise(res=>setTimeout(res, 600));
      return localReply(message);
    }
    throw e;
  }
}

function localReply(q){
  const t = q.toLowerCase();
  const d = state.dash, recos = d.recos || [];
  const has = (...w)=>w.some(x=>t.includes(x));

  if(has('factura','precio','costo','cuesta','pesos','tarifa')){
    const b = (state.bills||[])[0];
    let r = `El agua está asociada a ${cop(state.precioM3,2)} por m³. Tu consumo de esta semana (${d.total.toLocaleString('es')} L) cuesta ≈ ${cop(costOf(d.total))}.`;
    r += b ? `\nTu última factura (${fmtShort(b.period_start)}–${fmtShort(b.period_end)}) es de ${cop(b.facturado_cop)}; mira la comparación en la pestaña Factura.`
           : '\nRegistra tu factura en la pestaña Factura para compararla con lo que miden tus sensores.';
    return r;
  }
  if(has('semana','consumo','cómo voy','como voy','límite','limite','total')){
    const rel = d.diffPct<=0
      ? `${Math.abs(d.diffPct)}% por debajo de tu límite recomendado`
      : `${d.diffPct}% por encima de tu límite recomendado`;
    return `Esta semana llevas ${d.total.toLocaleString('es')} L (≈ ${cop(costOf(d.total))}), ${rel} (${state.weeklyLimit.toLocaleString('es')} L).` +
      (d.overLimit ? '\nSi quieres, te doy ideas para bajarlo.' : '');
  }
  const hit = recos.find(r => has(...r.t.toLowerCase().split(/\s+/).filter(w=>w.length>4)));
  if(hit) return `${hit.t}\n${hit.d}`;
  if(has('ahorr','consejo','tip','recomend','reduc','bajar')){
    if(!recos.length) return 'Aún no tengo recomendaciones para ti. Registra más actividad y vuelve a preguntarme.';
    return 'Estos consejos aplican a tu hogar:\n' + recos.slice(0,3).map(r=>`• ${r.t}: ${r.d}`).join('\n');
  }
  if(has('sensor','dispositivo','fuga')){
    return `Tienes ${state.sensors.length} sensor(es) registrado(s). Puedes agregar o quitar sensores desde la pestaña Perfil.`;
  }
  return 'Puedo ayudarte con tu consumo semanal y su costo, tu factura y consejos para ahorrar agua. ¿Cuál te interesa?';
}

/* ---------- INIT ---------- */
(function init(){
  if(localStorage.getItem(TOKEN_KEY)) enterApp();
})();