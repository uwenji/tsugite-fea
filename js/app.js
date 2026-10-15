// Tsugite Joint FEA — app state, UI, loading and the frame loop.
// Left: the compare.html topics (charts.js). Right: the CalculiX results in WebGPU (gpu.js), either one load case
// across the joints (one viewport per joint, shared camera and colour range) or one joint alone.
import { Store, FIELDS, fieldById, fieldRange, frameAt } from './data.js';
import { Charts, TYPES, AX, fmt } from './charts.js';
import { Renderer } from './gpu.js';
import { CameraRig, HOME_DIRS } from './camera.js';
import { CMAPS, cmapFor, paintLegend, BODY_RGB, hexToRgb } from './colormap.js';
import { buildRig } from './rig.js';

const $ = (id) => document.getElementById(id);
const cssVar = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
const TYPE_LABEL = Object.fromEntries(TYPES.map(([k, l]) => [k, l.replace(/ \(.*\)/, '')]));
const AXIAL = new Set(['compression', 'tension']);
const caseKey = (type, sense) => AXIAL.has(type) ? type : `${type}_${sense === '-' ? 'neg' : 'pos'}`;
const splitKey = (key) => { const m = key.match(/^(.*)_(pos|neg)$/); return m ? [m[1], m[2] === 'neg' ? '-' : '+'] : [key, '+']; };
const caseLabel = (type, sense) => TYPE_LABEL[type] + (AXIAL.has(type) ? '' : ' ' + (sense === '-' ? '−' : '+'));
const niceNear = (v) => { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); let best = p, bd = Infinity; for (const f of [1, 2, 5, 10]) { const d = Math.abs(Math.log(f * p / v)); if (d < bd) { bd = d; best = f * p; } } return best; };

// ------------------------------------------------------------------------------------------------------- state
const S = {
  mode: 'compare', type: 'bending', sense: '+', joint: null, cmpOff: ['solid'], field: 'MISES', cmap: 'auto', layout: 'rows',
  t: 1, playing: false, playDur: 6, hold: 0, scale: 10, scaleAuto: true, range: 'robust', manual: null,
  secAxis: 'off', secPos: { x: 0, y: 0, z: 0 }, secFlip: false, skin: 1, inner: true, edges: true, rig: true, bands: false,
  explode: 0, expAx: 1, bodyOff: [], topic: 'radar', theme: 'auto', tour: false, leftW: null, toolsCmp: false, toolsSingle: true,
};
const PERSIST = ['mode', 'type', 'sense', 'joint', 'cmpOff', 'field', 'cmap', 'layout', 'range', 'secAxis', 'secFlip', 'skin', 'inner', 'edges', 'rig', 'bands', 'expAx', 'topic', 'theme', 'leftW', 'toolsCmp', 'toolsSingle', 'scaleAuto', 'scale'];
try { Object.assign(S, Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem('jfea.state') || '{}')).filter(([k]) => PERSIST.includes(k)))); } catch (e) {}
parseHash();
let saveT = 0;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem('jfea.state', JSON.stringify(Object.fromEntries(PERSIST.map(k => [k, S[k]])))); } catch (e) {}
  const h = S.mode === 'single' ? `#single/${S.joint}/${caseKey(S.type, S.sense)}/${S.field}` : `#compare/${caseKey(S.type, S.sense)}/${S.field}`;
  if (location.hash !== h) history.replaceState(null, '', h); }, 250); }
function parseHash() {
  const p = decodeURIComponent(location.hash.slice(1)).split('/').filter(Boolean); if (!p.length) return;
  if (p[0] === 'single' && p[1]) { S.mode = 'single'; S.joint = p[1]; if (p[2]) [S.type, S.sense] = splitKey(p[2]); if (p[3]) S.field = p[3]; }
  else if (p[0] === 'compare') { S.mode = 'compare'; if (p[1]) [S.type, S.sense] = splitKey(p[1]); if (p[2]) S.field = p[2]; }
}

let store, charts, R = null, cam, JOINTS = [], SOLID = 'solid', BODIES = [];
let views = [];            // current viewports: {body, name, case, meshGPU, caseGPU, rect (device px), css rect}
let dirty = true, lastDom = 0, loadingToken = 0;

// ------------------------------------------------------------------------------------------------------- boot
boot().catch(e => { console.error(e); setMsg('start failed: ' + e.message); });

async function boot() {
  applyTheme();
  store = await new Store('data/').init();
  const D = store.compare;
  SOLID = D?.solid || 'solid';
  const exported = new Set(Object.values(store.index.cases).map(c => c.joint));
  BODIES = (D?.bodies || store.index.joints).filter(b => exported.has(b) || !D);
  JOINTS = BODIES.filter(b => b !== SOLID);
  if (!S.joint || !BODIES.includes(S.joint)) S.joint = JOINTS[0] || BODIES[0];
  $('left-foot').textContent = D ? `scores from cases/compare.html · generated ${D.generated} · results exported ${store.index.generated} · ${store.index.total_mb} MB` : 'cases/compare.html not found — run python compare.py, then python web_export.py --compare-only';
  if (D) charts = new Charts(D, {
    onAxis: (type, sense) => { setMode('compare'); setCase(type, AXIAL.has(type) ? '+' : sense); },
    onBar: (body, key) => { if (!BODIES.includes(body)) return; S.joint = body; setMode('single'); setCase(...splitKey(key)); },
    onCase: (key) => { setCase(...splitKey(key)); },
  });
  else $('topic-body').innerHTML = '<p class="note">No scores yet: run <code>python compare.py</code> and then <code>python web_export.py --compare-only</code>.</p>';
  buildUI();
  showTopic(S.topic);
  cam = new CameraRig($('gpu'));
  cam.attachNav($('navcube'));
  cam.onUser = () => { pauseTour(); };
  cam.controls.addEventListener('change', () => { dirty = true; });
  try {
    R = await Renderer.create($('gpu'));
    R.onLost = () => { $('nogpu').hidden = false; $('nogpu-why').textContent = 'the GPU device was lost — reload the page'; };
    const a = R.info; $('st-backend').textContent = `WebGPU${a.vendor ? ' · ' + a.vendor : ''}${a.architecture ? ' ' + a.architecture : ''}`; $('st-backend').classList.add('gpu');
  } catch (e) {
    console.warn(e); $('nogpu').hidden = false; $('nogpu-why').textContent = e.message; $('st-backend').textContent = 'no WebGPU';
  }
  applyTheme();
  setCmap();
  new ResizeObserver(() => resizeCanvas()).observe($('view'));
  resizeCanvas();
  await refresh(true);
  requestAnimationFrame(frame);
  if (/[?&]tour\b/.test(location.search)) startTour();        // index.html?tour: start in exhibition mode
}

// ------------------------------------------------------------------------------------------------------- UI
function buildUI() {
  // theme
  document.querySelectorAll('#theme-chips .chip').forEach(b => b.onclick = () => { S.theme = b.dataset.theme; applyTheme(); save(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
  // topics
  document.querySelectorAll('#topics button').forEach(b => b.onclick = () => { S.topic = b.dataset.topic; showTopic(S.topic); save(); });
  // mode, case
  document.querySelectorAll('#mode-seg button').forEach(b => b.onclick = () => { setMode(b.dataset.mode); });
  $('type-chips').innerHTML = TYPES.map(([k, l]) => `<button class="chip" data-type="${k}" title="${l}">${l.replace(/ \(.*\)/, '').replace('Bending, flatwise', 'Bending flat').replace('Bending, edgewise', 'Bending edge')}</button>`).join('');
  document.querySelectorAll('#type-chips .chip').forEach(b => b.onclick = () => { setCase(b.dataset.type, S.sense); });
  document.querySelectorAll('#sense-seg button').forEach(b => b.onclick = () => { setCase(S.type, b.dataset.sense); });
  // fields, colour maps
  let html = '', grp = null;
  for (const f of FIELDS) { if (f.group !== grp) { if (grp !== null) html += '</optgroup>'; if (f.group) html += `<optgroup label="${f.group}">`; grp = f.group; } html += `<option value="${f.id}">${f.label}${f.unit ? ` [${f.unit}]` : ''}</option>`; }
  $('sel-field').innerHTML = html + '</optgroup>';
  $('sel-field').value = fieldById(S.field).id;
  $('sel-field').onchange = () => { S.field = $('sel-field').value; S.manual = null; updateRange(); save(); };
  $('sel-cmap').innerHTML = `<option value="auto">auto colours</option>` + Object.entries(CMAPS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('sel-cmap').value = S.cmap; $('sel-cmap').onchange = () => { S.cmap = $('sel-cmap').value; setCmap(); save(); };
  document.querySelectorAll('#layout-seg button').forEach(b => b.onclick = () => { S.layout = b.dataset.layout; layoutChanged(); save(); });
  // display tools
  $('tools-toggle').onclick = () => { const open = $('tools').classList.contains('closed'); if (S.mode === 'single') S.toolsSingle = open; else S.toolsCmp = open; syncToolsOpen(); save(); };
  document.querySelectorAll('#sec-seg button').forEach(b => b.onclick = () => { S.secAxis = b.dataset.axis; syncSection(); dirty = true; save(); });
  $('sec-flip').onclick = () => { S.secFlip = !S.secFlip; syncSection(); dirty = true; save(); };
  $('sl-sec').oninput = () => { if (S.secAxis === 'off') return; const [lo, hi] = secRange(); S.secPos[S.secAxis] = lo + (hi - lo) * $('sl-sec').value / 1000; syncSection(); dirty = true; };
  $('sl-skin').oninput = () => { S.skin = $('sl-skin').value / 100; syncTools(); dirty = true; save(); };
  $('ck-inner').onchange = () => { S.inner = $('ck-inner').checked; dirty = true; syncTools(); save(); };
  $('ck-edges').onchange = () => { S.edges = $('ck-edges').checked; dirty = true; save(); };
  $('ck-rig').onchange = () => { S.rig = $('ck-rig').checked; dirty = true; save(); };
  $('ck-bands').onchange = () => { S.bands = $('ck-bands').checked; paintLeg(); dirty = true; save(); };
  $('sl-explode').oninput = () => { S.explode = $('sl-explode').value / 100; syncTools(); dirty = true; };
  document.querySelectorAll('#exp-seg button').forEach(b => b.onclick = () => { S.expAx = +b.dataset.ax; syncTools(); dirty = true; save(); });
  // legend range
  document.querySelectorAll('#range-seg button').forEach(b => b.onclick = () => { S.range = b.dataset.range; S.manual = null; updateRange(); save(); });
  for (const id of ['leg-lo', 'leg-hi']) $(id).onchange = () => { const lo = parseFloat($('leg-lo').value), hi = parseFloat($('leg-hi').value);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) { S.manual = [lo, hi]; updateRange(); } };
  // timeline
  $('btn-play').onclick = () => { togglePlay(); };
  $('sl-t').oninput = () => { S.playing = false; syncPlay(); S.t = $('sl-t').value / 1000; dirty = true; domUpdate(true); };
  $('sl-scale').oninput = () => { const v = +$('sl-scale').value; S.scale = v === 0 ? 0 : Math.pow(10, -1 + 3.5 * v / 1000); S.scaleAuto = false; syncScale(); dirty = true; save(); };
  $('btn-scale-auto').onclick = () => { S.scaleAuto = true; autoScale(); save(); };
  // status bar
  $('btn-tour').onclick = () => { S.tour ? stopTour() : startTour(); };
  $('btn-full').onclick = () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {}); };
  // navigation
  $('nav-home').onclick = () => cam.home(S.type);
  $('nav-fit').onclick = () => fitToggle();
  $('nav-turn').onclick = () => { cam.setTurntable(!cam.turntable, 8); $('nav-turn').classList.toggle('on', cam.turntable); };
  $('nav-proj').onclick = () => toggleProj();
  $('nav-up').onclick = () => cam.orbitBy(0, -Math.PI / 2); $('nav-down').onclick = () => cam.orbitBy(0, Math.PI / 2);
  $('nav-left').onclick = () => cam.orbitBy(Math.PI / 2, 0); $('nav-right').onclick = () => cam.orbitBy(-Math.PI / 2, 0);
  // divider
  initDivider();
  // canvas: probe and double-click
  const cv = $('gpu');
  cv.addEventListener('pointermove', (e) => { if (e.buttons) { $('probe').hidden = true; return; } probeAt(e); });
  cv.addEventListener('pointerleave', () => { $('probe').hidden = true; });
  cv.addEventListener('dblclick', (e) => { const v = viewAt(e); if (v && S.mode === 'compare') { S.joint = v.body; setMode('single'); } });
  addEventListener('keydown', onKey);
  ['pointerdown', 'keydown', 'wheel'].forEach(ev => addEventListener(ev, () => pauseTour(), { passive: true }));
  addEventListener('resize', () => { clearTimeout(window.__rt); window.__rt = setTimeout(() => charts?.drawAll(), 150); });
}

function onKey(e) {
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'h') cam.home(S.type);
  else if (k === 'f') fitToggle();
  else if (k === 't') $('nav-turn').click();
  else if (k === 'p') toggleProj();
  else if (k === 'arrowright' || k === 'arrowleft') { stepFrame(k === 'arrowright' ? 1 : -1); e.preventDefault(); }
  else if (k === 'escape') { $('probe').hidden = true; }
}

function toggleProj() {
  cam.setProjection(cam.projection === 'persp' ? 'ortho' : 'persp');
  const o = cam.projection === 'ortho';
  document.querySelector('#nav-proj .ic-persp').toggleAttribute('hidden', o); document.querySelector('#nav-proj .ic-ortho').toggleAttribute('hidden', !o);
  $('nav-proj').title = o ? 'Orthographic — click for perspective (P)' : 'Perspective — click for orthographic (P)';
  dirty = true;
}
let fitJoint = false;
function fitToggle() {
  const m = views.find(v => v.case)?.case?.mesh; fitJoint = !fitJoint;
  if (fitJoint && m?.meta?.joint_y) { const [a, b] = m.meta.joint_y, lo = [...m.lo], hi = [...m.hi]; lo[1] = a - 25; hi[1] = b + 25; cam.fit({ lo, hi }); }
  else { fitJoint = false; cam.fit(); }
}

function applyTheme() {
  const root = document.documentElement;
  if (S.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = S.theme;
  try { localStorage.setItem('jfea.theme', S.theme); } catch (e) {}
  document.querySelectorAll('#theme-chips .chip').forEach(b => b.classList.toggle('on', b.dataset.theme === S.theme));
  if (R) { const c = hexToRgb(cssVar('--canvas', '#f6f6f5')); R.clear = [...c, 1]; }
  cam?.nav?.applyTheme();
  charts?.drawAll();
  dirty = true;
}

function showTopic(t) {
  document.querySelectorAll('#topics button').forEach(b => b.setAttribute('aria-selected', b.dataset.topic === t));
  for (const k of ['radar', 'bars', 'fd']) $('topic-' + k).hidden = k !== t;
  if (!charts) return;
  if (t === 'radar') charts.drawRadar(); else if (t === 'bars') charts.drawBars(); else charts.drawFD();
}

function setMsg(m) { $('st-msg').textContent = m; }
function syncToolsOpen() { const open = S.mode === 'single' ? S.toolsSingle : S.toolsCmp; if ($('tools').classList.contains('closed') === open) { $('tools').classList.toggle('closed', !open); } }

function initDivider() {
  const dv = $('divider'), left = $('left');
  if (S.leftW) left.style.width = S.leftW + 'px';
  let x0 = 0, w0 = 0;
  dv.addEventListener('pointerdown', (e) => { x0 = e.clientX; w0 = left.getBoundingClientRect().width; dv.setPointerCapture(e.pointerId); dv.classList.add('drag'); });
  dv.addEventListener('pointermove', (e) => { if (!dv.classList.contains('drag')) return; const w = Math.max(280, Math.min(innerWidth * 0.75, w0 + e.clientX - x0)); left.style.width = w + 'px'; S.leftW = Math.round(w); });
  const up = () => { if (!dv.classList.contains('drag')) return; dv.classList.remove('drag'); save(); charts?.drawAll(); };
  dv.addEventListener('pointerup', up); dv.addEventListener('pointercancel', up);
  dv.addEventListener('keydown', (e) => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; const w = left.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? -40 : 40);
    left.style.width = Math.max(280, Math.min(innerWidth * 0.75, w)) + 'px'; S.leftW = Math.round(w); save(); charts?.drawAll(); });
  dv.addEventListener('dblclick', () => { left.style.width = ''; S.leftW = null; save(); charts?.drawAll(); });
}

function resizeCanvas() {
  const st = $('view'), cv = $('gpu'), dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(st.clientWidth * dpr)), h = Math.max(1, Math.round(st.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  cam?.nav?.resize();
  const a0 = cam?.aspect;
  layoutViews(); dirty = true;
  // the view changed shape (sidebar, divider, window): keep the bar framed
  if (cam && views.length && a0 && Math.abs(cam.aspect / a0 - 1) > 0.01 && !cam.anim && !cam.turntable) cam.lookFrom(cam.viewDir(), { ms: 0, tiltFrom: cam.viewDir() });
}

// ------------------------------------------------------------------------------------------------------- mode / case
function setMode(m) {
  const changed = S.mode !== m; S.mode = m;
  refresh(changed); save();
}
function setCase(type, sense) {
  const newType = type !== S.type;
  S.type = type; S.sense = AXIAL.has(type) ? '+' : (sense || S.sense); S.manual = null;
  charts?.setCase(caseKey(S.type, S.sense));
  refresh(newType); save();
}
function layoutChanged() { layoutViews(); cam.lookFrom(cam.viewDir(), { ms: 300 }); dirty = true; }

function shownBodies() { return S.mode === 'single' ? [S.joint] : BODIES.filter(b => !S.cmpOff.includes(b)); }

function syncToolbar() {
  document.querySelectorAll('#mode-seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === S.mode));
  document.querySelectorAll('#type-chips .chip').forEach(b => {
    b.classList.toggle('on', b.dataset.type === S.type);
    const any = BODIES.some(j => store.has(`${j}_${caseKey(b.dataset.type, '+')}`) || store.has(`${j}_${caseKey(b.dataset.type, '-')}`));
    b.disabled = !any;
  });
  document.querySelectorAll('#sense-seg button').forEach(b => { b.setAttribute('aria-pressed', b.dataset.sense === S.sense && !AXIAL.has(S.type)); b.disabled = AXIAL.has(S.type); });
  document.querySelectorAll('#layout-seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.layout === S.layout));
  $('layout-seg').hidden = S.mode !== 'compare';
  const key = caseKey(S.type, S.sense);
  $('joint-chips').innerHTML = BODIES.map(b => {
    const on = S.mode === 'single' ? b === S.joint : !S.cmpOff.includes(b), has = store.has(`${b}_${key}`);
    const col = `var(--s${store.compare?.slots?.[b] || 8})`;
    return `<button class="chip${on ? ' on' : ''}" data-b="${b}" ${has ? '' : 'title="no exported result for this case"'} style="${has ? '' : 'opacity:.5'}"><i class="key" style="background:${col}"></i>${b}</button>`;
  }).join('');
  document.querySelectorAll('#joint-chips .chip').forEach(b => b.onclick = () => {
    const body = b.dataset.b;
    if (S.mode === 'single') { S.joint = body; }
    else { S.cmpOff = S.cmpOff.includes(body) ? S.cmpOff.filter(x => x !== body) : [...S.cmpOff, body]; if (BODIES.every(x => S.cmpOff.includes(x))) S.cmpOff = S.cmpOff.filter(x => x !== body); }
    refresh(false); save();
  });
  $('sel-field').value = fieldById(S.field).id;
  document.querySelectorAll('#range-seg button').forEach(b => b.setAttribute('aria-pressed', !S.manual && b.dataset.range === S.range));
  const nb = shownBodies().length;
  $('st-case').textContent = S.mode === 'single' ? `${S.joint} · ${caseLabel(S.type, S.sense)}` : `${caseLabel(S.type, S.sense)} · ${nb} ${nb === 1 ? 'body' : 'bodies'}`;
  syncToolsOpen();
  $('btn-tour').classList.toggle('on', S.tour);
}

/** (re)build the viewports for the current mode/case, loading whatever is missing */
async function refresh(rehome) {
  syncToolbar(); syncTools(); syncSection();
  const key = caseKey(S.type, S.sense), bodies = shownBodies();
  if (charts && charts.cur !== key) charts.setCase(key);
  const want = bodies.map(b => ({ body: b, name: `${b}_${key}` }));
  const token = ++loadingToken;
  const missing = want.filter(w => store.has(w.name) && !store.cases.has(w.name));
  if (missing.length) { $('loading').hidden = false; $('loading').textContent = `loading ${missing.map(w => w.name).join(', ')} …`; }
  const loaded = await Promise.all(want.map(w => store.has(w.name) ? store.case(w.name).catch(e => { console.error(e); return null; }) : null));
  if (token !== loadingToken) return;                         // a newer request took over
  $('loading').hidden = true;
  views = want.map((w, i) => ({ ...w, case: loaded[i] }));
  if (R) for (const v of views) if (v.case) {
    v.meshGPU = R.meshGPU(v.case.mesh); v.caseGPU = R.caseGPU(v.case);
  }
  if (R) R.trim(new Set(views.map(v => v.name)));
  const m = views.find(v => v.case)?.case?.mesh;
  if (m) { const fb = fitBox(m); cam.setBox(fb.lo, fb.hi); }
  layoutViews();
  buildBodyChips();
  rebuildRigs();
  if (S.scaleAuto) autoScale(); else syncScale();
  updateRange();
  buildTicks();
  if (rehome) cam.home(S.type, views.length ? 450 : 0);
  dirty = true;
  domUpdate(true);
}

/** the box the camera frames: the bar plus the rig of the load case (arrows, supports, grips) */
function fitBox(m) {
  const lo = [...m.lo], hi = [...m.hi], pad = (j, a, b) => { lo[j] -= a; hi[j] += b; };
  const tools = m.bodies.filter(b => b.role === 'tool');
  for (const t of tools) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], t.lo[j]); hi[j] = Math.max(hi[j], t.hi[j]); }
  const T = S.type, r = S.rig;
  if (T === 'bending' || T === 'shear_z') pad(2, r ? 14 : 4, r ? 40 : 4);
  else if (T === 'bending_edge' || T === 'shear_x') pad(0, r ? 40 : 4, r ? 40 : 4);
  else if (T === 'tension' || T === 'compression') pad(1, 6, r ? 48 : 6);
  else if (T === 'torsion') { pad(0, r ? 12 : 4, r ? 12 : 4); pad(2, r ? 12 : 4, r ? 12 : 4); pad(1, 4, 12); }
  for (let j = 0; j < 3; j++) { lo[j] -= 3; hi[j] += 3; }
  return { lo, hi };
}

function layoutViews() {
  const st = $('view'), W = st.clientWidth, H = st.clientHeight, dpr = $('gpu').width / Math.max(1, W);
  const n = views.length || 1;
  let cols = 1, rows = n;
  if (S.mode === 'compare' && S.layout === 'grid') { cols = n <= 1 ? 1 : n <= 4 ? 2 : 3; rows = Math.ceil(n / cols); }
  if (S.mode === 'single') { cols = 1; rows = 1; }
  const cw = W / cols, ch = H / rows;
  views.forEach((v, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    v.css = [c * cw, r * ch, cw, ch];
    v.rect = [c * cw * dpr, r * ch * dpr, cw * dpr, ch * dpr];
  });
  cam?.setAspect(cw / Math.max(1, ch));
  // labels and frames
  const lab = $('labels'); lab.innerHTML = '';
  views.forEach((v, i) => {
    if (views.length > 1) { const f = document.createElement('div'); f.className = 'vframe'; Object.assign(f.style, { left: v.css[0] + 'px', top: v.css[1] + 'px', width: v.css[2] + 'px', height: v.css[3] + 'px' }); lab.appendChild(f); }
    const d = document.createElement('div'); d.className = 'vlabel'; d.dataset.i = i;
    Object.assign(d.style, { left: v.css[0] + 8 + 'px', top: v.css[1] + 6 + 'px' });
    d.title = S.mode === 'compare' ? 'open this joint alone' : '';
    d.onclick = () => { if (S.mode === 'compare') { S.joint = v.body; setMode('single'); } };
    lab.appendChild(d); v.label = d;
  });
  labelText();
}

function labelText() {
  const key = caseKey(S.type, S.sense);
  for (const v of views) {
    if (!v.label) continue;
    const r = store.compare?.runs?.[`${v.body}|${key}`];
    const col = `var(--s${store.compare?.slots?.[v.body] || 8})`;
    const score = v.body === SOLID ? 'reference 100 %' : r?.score !== undefined ? `${r.score.toFixed(1)} % of solid` : '';
    let warn = '';
    if (!v.case) warn = store.has(v.name) ? 'loading…' : 'not exported';
    else { const te = v.case.times[v.case.times.length - 1]; if (te < 0.999) warn = `run stops at t = ${te}`; if (r && r.state !== 'complete') warn = (warn ? warn + ' · ' : '') + r.state; }
    v.label.innerHTML = `<i class="key" style="background:${col}"></i><b>${v.body}</b>${S.mode === 'single' ? `<span>${caseLabel(S.type, S.sense)}</span>` : ''}<span class="score">${score}</span>${warn ? `<span class="warn">${warn}</span>` : ''}`;
  }
}

// ------------------------------------------------------------------------------------------------------- bodies, rig
function bodyKind(b) { return b.role === 'tool' ? 'tool' : b.role === 'peg' ? 'peg' : b.name === 'half_A' ? 'half_A' : b.name === 'half_B' ? 'half_B' : 'wood'; }
const KIND_LABEL = { half_A: 'half A', half_B: 'half B', peg: 'pegs / keys', tool: 'platens', wood: 'wood' };
function buildBodyChips() {
  const kinds = new Set();
  for (const v of views) if (v.case) for (const b of v.case.mesh.bodies) kinds.add(bodyKind(b));
  $('body-chips').innerHTML = [...kinds].map(k => `<button class="chip${S.bodyOff.includes(k) ? '' : ' on'}" data-k="${k}">${KIND_LABEL[k]}</button>`).join('');
  document.querySelectorAll('#body-chips .chip').forEach(b => b.onclick = () => {
    const k = b.dataset.k; S.bodyOff = S.bodyOff.includes(k) ? S.bodyOff.filter(x => x !== k) : [...S.bodyOff, k];
    buildBodyChips(); dirty = true; });
  $('bodies-row').hidden = kinds.size < 2;
}
function rebuildRigs() {
  if (!R) return;
  const col = { load: hexToRgb(cssVar('--crit', '#d03b3b')), support: [0.35, 0.37, 0.40], grip: [0.30, 0.32, 0.36] };
  views.forEach((v, i) => { if (!v.case) return; R.setRig(i, v.name, buildRig(v.case, S.type, col)); });
}

function explodeOffsets(mesh) {
  const a = S.explode, ax = S.expAx, B = mesh.bodies, out = B.map(() => [0, 0, 0]);
  if (a <= 0) return out;
  const jy = mesh.meta?.joint_y || [mesh.lo[1], mesh.hi[1]], cy = (jy[0] + jy[1]) / 2, over = Math.abs(jy[1] - jy[0]);
  const hx = (mesh.hi[0] - mesh.lo[0]) / 2, hz = (mesh.hi[2] - mesh.lo[2]) / 2;
  const A = B.find(b => b.name === 'half_A'), Bb = B.find(b => b.name === 'half_B');
  const dist = ax === 1 ? over / 2 + 30 : ax === 0 ? hx + 18 : hz + 18;
  let sgn = 1;
  if (ax !== 1 && A && Bb) { const d = A.centroid[ax] - Bb.centroid[ax]; sgn = Math.abs(d) > 0.5 ? Math.sign(d) : 1; }
  B.forEach((b, i) => {
    const k = bodyKind(b);
    if (k === 'half_A') out[i][ax] = sgn * a * dist;
    else if (k === 'half_B') out[i][ax] = -sgn * a * dist;
    else if (k === 'peg') {                                          // pegs and keys leave along their longest cross axis
      const ext = [0, 1, 2].map(j => b.hi[j] - b.lo[j]); const pa = ext[0] > ext[2] ? 0 : 2;
      const side = Math.sign(b.centroid[pa] - 0) || 1;
      out[i][pa] = side * a * (ext[pa] + 30);
    } else if (k === 'tool' && ax === 1) out[i][1] = Math.sign(b.centroid[1] - cy) * a * dist;
  });
  return out;
}

// ------------------------------------------------------------------------------------------------------- display tools
function secRange() {
  const m = views.find(v => v.case)?.case?.mesh, j = { x: 0, y: 1, z: 2 }[S.secAxis] ?? 1;
  return m ? [m.lo[j] - 0.5, m.hi[j] + 0.5] : [-200, 200];
}
function syncSection() {
  document.querySelectorAll('#sec-seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.axis === S.secAxis));
  $('sec-flip').classList.toggle('on', S.secFlip);
  const on = S.secAxis !== 'off'; $('sl-sec').disabled = !on; $('sec-flip').disabled = !on;
  if (on) {
    const [lo, hi] = secRange(), p = S.secPos[S.secAxis];
    $('sl-sec').value = Math.round(1000 * (p - lo) / Math.max(hi - lo, 1e-9)); $('out-sec').textContent = p.toFixed(1);
  } else $('out-sec').textContent = '—';
  syncTools();
}
function syncTools() {
  $('sl-skin').value = Math.round(S.skin * 100); $('out-skin').textContent = Math.round(S.skin * 100) + ' %';
  $('ck-inner').checked = S.inner; $('ck-edges').checked = S.edges; $('ck-rig').checked = S.rig; $('ck-bands').checked = S.bands;
  $('sl-explode').value = Math.round(S.explode * 100); $('out-explode').textContent = Math.round(S.explode * 100) + ' %';
  document.querySelectorAll('#exp-seg button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.ax === S.expAx));
  const parts = [];
  if (S.secAxis !== 'off') parts.push(`cut ${S.secAxis.toUpperCase()} ${S.secPos[S.secAxis].toFixed(0)}`);
  if (S.skin < 1) parts.push(`skin ${Math.round(S.skin * 100)} %`);
  if (S.explode > 0) parts.push(`explode ${Math.round(S.explode * 100)} %`);
  $('tools-toggle').title = 'show / hide the display tools' + (parts.length ? ' · ' + parts.join(' · ') : '');
}

// ------------------------------------------------------------------------------------------------------- range, scale
function setCmap() {
  if (!R) { paintLeg(); return; }
  const F = fieldById(S.field), name = cmapFor(S.cmap, F.kind);
  R.setLUT(CMAPS[name].lut); S._cmapName = name; paintLeg(); dirty = true;
}
function currentFrameIdx(c) { const f = frameAt(c, S.t); return f.mix > 0.5 ? f.f1 : f.f0; }
function updateRange() {
  const F = fieldById(S.field);
  if (F.code < 0) { S._range = [0, 1]; setCmap(); return; }
  let lo = Infinity, hi = -Infinity, peak = -Infinity, low = Infinity;
  for (const v of views) {
    if (!v.case) continue;
    const f = S.range === 'frame' ? currentFrameIdx(v.case) : v.case.nFrames - 1;
    const [a, b] = fieldRange(v.case, S.field, f, S.range === 'robust' ? 'robust' : 'full');
    const [pa, pb] = fieldRange(v.case, S.field, f, 'full');
    lo = Math.min(lo, a); hi = Math.max(hi, b); peak = Math.max(peak, pb); low = Math.min(low, pa);
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (hi - lo < 1e-12) hi = lo + (Math.abs(lo) || 1) * 1e-3;
  S._range = S.manual || [lo, hi]; S._peak = [low, peak];
  $('leg-lo').value = +S._range[0].toPrecision(3); $('leg-hi').value = +S._range[1].toPrecision(3);
  document.querySelectorAll('#range-seg button').forEach(b => b.setAttribute('aria-pressed', !S.manual && b.dataset.range === S.range));
  setCmap();
}
function paintLeg() {
  const F = fieldById(S.field), name = S._cmapName || cmapFor(S.cmap, F.kind);
  $('legend').classList.toggle('geom', F.code < 0);
  if (F.code < 0) { $('leg-title').innerHTML = 'geometry · oak halves, walnut pegs and keys, steel rig'; $('leg-ticks').innerHTML = ''; $('leg-bar').getContext('2d').clearRect(0, 0, 256, 10); return; }
  paintLegend($('leg-bar'), name, S.bands ? 10 : 0);
  const [lo, hi] = S._range || [0, 1];
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => lo + (hi - lo) * t);
  $('leg-ticks').innerHTML = ticks.map((v, i) => `<span style="left:${i * 25}%">${fmtV(v)}</span>`).join('');
  const pk = S._peak || [lo, hi], beyond = [];
  if (pk[1] > hi * (hi > 0 ? 1.02 : 0.98) + 1e-9) beyond.push(`max ${fmtV(pk[1])}`);
  if (pk[0] < lo * (lo < 0 ? 1.02 : 0.98) - 1e-9 && F.kind === 'div') beyond.push(`min ${fmtV(pk[0])}`);
  $('leg-title').innerHTML = `${F.label} <span class="unit">${F.unit ? '[' + F.unit + ']' : ''}</span>${beyond.length ? `<span class="beyond" title="the colours stop at the ends of the scale; these values lie beyond">▲ beyond: ${beyond.join(', ')}</span>` : ''}`;
}
const fmtV = (v) => { const a = Math.abs(v); return a === 0 ? '0' : a >= 1000 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : a >= 0.01 ? v.toFixed(3) : v.toExponential(1); };

function autoScale() {
  let umax = 0;
  for (const v of views) if (v.case) { const s = v.case.stats?.[v.case.nFrames - 1]; if (s) umax = Math.max(umax, s.umax); }
  const L = views.find(v => v.case)?.case?.mesh ? (views.find(v => v.case).case.mesh.hi[1] - views.find(v => v.case).case.mesh.lo[1]) : 400;
  S.scale = umax > 0 ? Math.max(1, niceNear(0.04 * L / umax)) : 1;
  syncScale(); dirty = true;
}
function syncScale() {
  $('sl-scale').value = S.scale <= 0 ? 0 : Math.round((Math.log10(S.scale) + 1) / 3.5 * 1000);
  $('out-scale').textContent = S.scale === 0 ? 'off' : S.scale >= 10 ? S.scale.toFixed(0) : S.scale.toFixed(S.scale >= 1 ? 1 : 2);
  $('btn-scale-auto').classList.toggle('on', S.scaleAuto);
}

// ------------------------------------------------------------------------------------------------------- timeline
function buildTicks() {
  const tk = $('tl-ticks'); tk.innerHTML = '';
  const seen = new Set();
  for (const v of views) if (v.case) {
    const T = v.case.times;
    for (const t of T.slice(1)) { const k = Math.round(t * 200); if (seen.has(k)) continue; seen.add(k); const i = document.createElement('i'); i.style.left = (t * 100) + '%'; tk.appendChild(i); }
    const te = T[T.length - 1]; if (te < 0.999) { const i = document.createElement('i'); i.className = 'end'; i.style.left = (te * 100) + '%'; i.title = `${v.body} stops at t = ${te}`; tk.appendChild(i); }
  }
}
function togglePlay() { S.playing = !S.playing; if (S.playing && S.t >= 0.999) S.t = 0; S.hold = 0; syncPlay(); dirty = true; }
function syncPlay() { $('btn-play').textContent = S.playing ? '❚❚' : '▶'; $('btn-play').title = S.playing ? 'Pause (space)' : 'Play the loading (space)'; }
function stepFrame(d) {
  S.playing = false; syncPlay();
  const c = views.find(v => v.case)?.case; if (!c) return;
  const T = c.times; let i = T.findIndex(t => t > S.t + 1e-6); if (i < 0) i = T.length;
  const cur = T.reduce((b, t, k) => Math.abs(t - S.t) < Math.abs(T[b] - S.t) ? k : b, 0);
  const k = Math.max(0, Math.min(T.length - 1, cur + d));
  S.t = T[k]; dirty = true; domUpdate(true);
}

// ------------------------------------------------------------------------------------------------------- uniforms
function uniformsFor(v, pick) {
  const U = new Float32Array(112), c = v.case, m = c.mesh;
  const aspect = v.rect[2] / Math.max(1, v.rect[3]);
  U.set(cam.viewProj(aspect, pick), 0);
  U.set(cam.eye(), 16);
  if (S.secAxis !== 'off') {
    const j = { x: 0, y: 1, z: 2 }[S.secAxis], n = [0, 0, 0]; n[j] = (S.secAxis === 'y' ? -1 : 1) * (S.secFlip ? -1 : 1);
    U.set([n[0], n[1], n[2], n[j] * S.secPos[S.secAxis]], 20);
  }
  const f = frameAt(c, S.t);
  U.set([f.f0, f.f1, f.mix, S.scale], 24);
  const F = fieldById(S.field), r = S._range || [0, 1];
  U.set([F.code, r[0], r[1], S.bands ? 10 : 0], 28);
  U.set([S.secAxis !== 'off' ? 1 : 0, S.skin, F.code < 0 ? 1 : 0, c.nNodes], 32);
  U.set([...cam.up(), 0.52], 36);
  U.set([0.94, views.indexOf(v), -1, 1.5e-5], 40);
  const dark = cssVar('--scheme', 'light') === 'dark';
  U.set(dark ? [0.92, 0.93, 0.95, 0.30] : [0.10, 0.11, 0.12, 0.42], 44);
  const off = explodeOffsets(m);
  m.bodies.forEach((b, i) => {
    if (i >= 8) return;
    const vis = !S.bodyOff.includes(bodyKind(b));
    U.set([...off[i], vis ? 1 : 0], 48 + 4 * i);
    const kind = bodyKind(b), rgb = BODY_RGB[kind === 'half_A' || kind === 'half_B' ? kind : kind] || BODY_RGB.wood;
    U.set([...rgb, kind === 'tool' ? 1 : 0], 80 + 4 * i);
  });
  return U;
}

function gpuViews() {
  return views.map(v => v.case && v.meshGPU ? {
    rect: v.rect, meshGPU: v.meshGPU, caseGPU: v.caseGPU, uniform: uniformsFor(v),
    skinAlpha: S.skin, inner: S.inner || S.skin < 0.995, edges: S.edges, section: S.secAxis !== 'off', rig: S.rig && S.explode === 0, tools: true,
  } : {});
}

// ------------------------------------------------------------------------------------------------------- frame loop
let lastT = performance.now(), lastVP = '';
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  tourTick(now);
  if (S.playing) {
    if (S.t >= 1) { S.hold += dt; if (S.hold > 1.6) { S.t = 0; S.hold = 0; } }
    else S.t = Math.min(1, S.t + dt / S.playDur);
    dirty = true;
  }
  cam.update();
  const vpKey = cam.camera.matrixWorldInverse.elements.join(',') + cam.ortho.zoom;
  if (vpKey !== lastVP) { lastVP = vpKey; dirty = true; }
  if (R && dirty && views.length) {
    dirty = false;
    try { R.render(gpuViews()); } catch (e) { console.error(e); setMsg('render error: ' + e.message); }
    if (S.range === 'frame' && !S.manual) { const k = views.map(v => v.case ? currentFrameIdx(v.case) : -1).join(); if (k !== S._rk) { S._rk = k; updateRange(); } }
  }
  if (now - lastDom > 90) { lastDom = now; domUpdate(false); }
}

let domKey = '';
function domUpdate(force) {
  const key = `${S.t.toFixed(4)}|${S.mode}|${S.type}|${S.sense}|${views.length}`;
  if (!force && key === domKey) return; domKey = key;
  $('sl-t').value = Math.round(S.t * 1000);
  const ckey = caseKey(S.type, S.sense), v0 = views.find(v => v.case);
  let txt = `t = ${S.t.toFixed(2)}`;
  if (S.mode === 'single' && v0 && charts) {
    const p = charts.curveAt(v0.body, ckey, v0.case.times, v0.case.curveIndex, S.t);
    if (p) { const ax = AX[S.type]; const fu = ax[1].match(/\[(.*)\]/)?.[1] || ''; const uu = ax[0].match(/\[(.*)\]/)?.[1] || ''; txt += ` · ${fmt(Math.abs(p.F))} ${fu} · ${fmt(Math.abs(p.u))} ${uu}`; }
  } else txt += ' of the load step';
  $('out-t').textContent = txt;
  if (v0) { const f = frameAt(v0.case, S.t); $('st-frame').textContent = S.mode === 'single' ? `increment ${f.mix > 0.5 ? f.f1 : f.f0}/${v0.case.nFrames - 1}` : ''; }
  // rings on the F–d chart
  if (charts) charts.setMarkers(views.filter(v => v.case).map(v => { const p = charts.curveAt(v.body, ckey, v.case.times, v.case.curveIndex, S.t); return p && { body: v.body, key: ckey, u: p.u, F: p.F }; }).filter(Boolean));
  labelText();
}

// ------------------------------------------------------------------------------------------------------- probe
let probeBusy = false, probeNext = null;
function viewAt(e) {
  const r = $('gpu').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  return views.find(v => v.css && x >= v.css[0] && x < v.css[0] + v.css[2] && y >= v.css[1] && y < v.css[1] + v.css[3]);
}
async function probeAt(e) {
  if (!R) return;
  if (probeBusy) { probeNext = e; return; }
  const v = viewAt(e); if (!v || !v.case) { $('probe').hidden = true; return; }
  probeBusy = true;
  try {
    const r = $('gpu').getBoundingClientRect(), dpr = $('gpu').width / r.width;
    const px = (e.clientX - r.left - v.css[0]) * dpr, py = (e.clientY - r.top - v.css[1]) * dpr;
    const gv = gpuViews(), i = views.indexOf(v);
    gv[i].pickUniform = uniformsFor(v, { x: px, y: py, w: v.rect[2], h: v.rect[3] });
    const res = await R.pick(gv, i, px, py);
    const pr = $('probe');
    if (!res) { pr.hidden = true; }
    else {
      const F = fieldById(S.field), b = v.case.mesh.bodies[Math.round(res.body)];
      pr.innerHTML = `<b>${v.body}</b> · ${b ? KIND_LABEL[bodyKind(b)] || b.name : ''}<br>${F.code < 0 ? 'geometry' : `${F.label}: <b>${fmtV(res.val)}</b> ${F.unit}`}`;
      pr.hidden = false;
      const st = $('view').getBoundingClientRect();
      pr.style.left = Math.min(st.width - pr.offsetWidth - 6, e.clientX - st.left + 14) + 'px';
      pr.style.top = Math.max(4, e.clientY - st.top - 40) + 'px';
    }
  } catch (err) { console.warn(err); }
  finally { probeBusy = false; if (probeNext) { const n = probeNext; probeNext = null; setTimeout(() => probeAt(n), 30); } }
}

// ------------------------------------------------------------------------------------------------------- exhibition tour
const TOUR_CASES = ['bending_pos', 'bending_neg', 'bending_edge_pos', 'torsion_pos', 'tension', 'compression', 'shear_z_pos', 'shear_x_pos', 'bending_edge_neg', 'torsion_neg'];
const TOUR_SECS = 16, TOUR_IDLE = 90;
let tourAt = 0, tourIdx = -1, tourPausedUntil = 0;
function startTour() { S.tour = true; tourPausedUntil = 0; tourAt = 0; setMode('compare'); S.topic = 'fd'; showTopic('fd'); cam.setTurntable(false); $('nav-turn').classList.remove('on'); syncToolbar(); }
function stopTour() { if (!S.tour) return; S.tour = false; cam.setSway(null); syncToolbar(); setMsg(''); }
function pauseTour() { if (S.tour) { tourPausedUntil = performance.now() + TOUR_IDLE * 1000; cam.setSway(null); setMsg(`auto tour paused, resumes after ${TOUR_IDLE} s without input`); } }
function tourTick(now) {
  if (!S.tour || now < tourPausedUntil) return;
  if (tourPausedUntil) { tourPausedUntil = 0; setMsg(''); tourAt = 0; if (S.mode !== 'compare') setMode('compare'); }
  if (now < tourAt) return;
  tourAt = now + TOUR_SECS * 1000;
  const avail = TOUR_CASES.filter(k => JOINTS.some(j => store.has(`${j}_${k}`)));
  if (!avail.length) return;
  tourIdx = (tourIdx + 1) % avail.length;
  const [type, sense] = splitKey(avail[tourIdx]);
  S.field = tourIdx % 3 === 2 ? 'CPRESS' : tourIdx % 3 === 1 ? 'SYY' : 'MISES';
  S.secAxis = 'off'; S.skin = tourIdx % 3 === 2 ? 0.18 : 1; S.inner = true; S.explode = 0;
  setCase(type, sense);
  S.t = 0; S.playing = true; S.hold = 0; syncPlay();
  cam.setSway(HOME_DIRS[type] || HOME_DIRS.default);
}
