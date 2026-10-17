// The three topics of compare.html (compare_template.html), drawn the same way from the same DATA, with hooks to the
// 3-D view: click a radar axis -> compare that load case; click a bar -> that joint alone; the F–d tab follows the case
// on the right and rings mark the increment shown there.
const NS = 'http://www.w3.org/2000/svg';
const el = (n, a = {}, p) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
const $ = (id) => document.getElementById(id);

export const TYPES = [['compression', 'Compression'], ['tension', 'Tension'], ['shear_z', 'Shear z (weak axis)'], ['shear_x', 'Shear x (strong axis)'],
  ['bending', 'Bending, flatwise'], ['bending_edge', 'Bending, edgewise'], ['torsion', 'Torsion']];
export const MEAS = { compression: 'gauge', tension: 'gauge', shear_z: 'clamp to clamp', shear_x: 'clamp to clamp', bending: 'gauge rotation', bending_edge: 'gauge rotation', torsion: 'gauge twist' };
export const AX = { compression: ['platen displacement [mm]', 'force [N]'], tension: ['clamp displacement [mm]', 'force [N]'], shear_z: ['clamp displacement [mm]', 'force [N]'],
  shear_x: ['clamp displacement [mm]', 'force [N]'], bending: ['load-line displacement [mm]', 'force per load line [N]'],
  bending_edge: ['load-line displacement [mm]', 'force per load line [N]'], torsion: ['clamp rotation [rad]', 'torque [N·mm]'] };
const RAD_AX = [['compression', 'Compression'], ['tension', 'Tension'], ['shear_z', 'Shear z ±'], ['bending', 'Bending flat ±'],
  ['shear_x', 'Shear x ±'], ['bending_edge', 'Bending edge ±'], ['torsion', 'Torsion ±']];

export const fmt = v => v === 0 ? '0' : Math.abs(v) >= 1e5 ? v.toExponential(2).replace('e+', 'e') : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(2);
function nice(m) { if (!(m > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(m))); for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= m) return f * p; }
function tipAt(tip, wrap, x, y, html) { tip.innerHTML = html; tip.hidden = false; const w = tip.offsetWidth, W = wrap.clientWidth + wrap.scrollLeft;
  tip.style.left = Math.max(4, Math.min(x + 14, W - w - 4)) + 'px'; tip.style.top = Math.max(0, y - 12) + 'px'; }

export class Charts {
  /** hooks: { onAxis(type, sense), onBar(body, caseKey), onCase(caseKey) } */
  constructor(DATA, hooks = {}) {
    this.D = DATA; this.h = hooks;
    this.SOLID = DATA.solid; this.JOINTS = DATA.bodies.filter(b => b !== DATA.solid);
    this.radState = { off: [], sense: 'both', link: true };
    try { const s = JSON.parse(localStorage.getItem('jfea.radar') || '{}'); if (Array.isArray(s.off)) this.radState.off = s.off; if (['both', '+', '-'].includes(s.sense)) this.radState.sense = s.sense; if (s.link === false) this.radState.link = false; } catch (e) {}
    this.view = null;                  // what the 3-D view shows: {bodies, key, type}
    const scores = Object.values(DATA.runs).filter(r => this.usable(r)).map(r => r.score);
    this.XMAX = Math.ceil(Math.max(100, ...scores) * 1.04 / 25) * 25;
    this.cur = DATA.cases.find(c => this.withCurve(c))?.key || DATA.cases[0].key;
    this.markers = [];
    this._legends(); this._radarCtl(); this._tabs();
  }

  /** the bodies and load case on the right: the radar follows them (unless unlinked), bars and curves highlight them */
  setView(v) {
    this.view = v; this._syncRadarCtl?.();
    const t = $('topic-body') && !$('topic-radar').hidden ? 'radar' : !$('topic-bars').hidden ? 'bars' : 'fd';
    if (t === 'radar') this.drawRadar(); else if (t === 'bars') this.drawBars(); else this.drawFD();
  }
  inView(b) { return !this.view || this.view.bodies.includes(b); }
  radarShown() {
    if (this.radState.link && this.view) return this.JOINTS.filter(j => this.radHas(j) && this.view.bodies.includes(j));
    return this.JOINTS.filter(j => this.radHas(j) && !this.radState.off.includes(j));
  }

  col(b) { return `var(--s${this.D.slots[b] || 8})`; }
  R(b, k) { return this.D.runs[b + '|' + k] || { state: 'not written' }; }
  keysOf(t) { return this.D.cases.filter(c => c.type === t); }
  usable(r) { return r.score !== undefined && (r.state === 'complete' || r.state === 'running'); }
  stale(r) { return r.state !== 'complete' || r.inputChanged || r.rerun; }
  provisional(r) { return r.rerun ? ' (old run, rerun pending)' : r.state !== 'complete' ? ' (still running, provisional)' : r.inputChanged ? ' (input changed since this run)' : ''; }
  caseLabel(c) { return TYPES.find(x => x[0] === c.type)[1].replace(/ \(.*\)/, '') + (c.sense ? ' ' + (c.sense === '-' ? '−' : '+') : ''); }
  withCurve(c) { return this.D.bodies.some(b => (this.R(b, c.key).u || []).length); }

  _legends() {
    const lb = (bodies) => bodies.map(b => `<span><i class="key" style="background:${this.col(b)}"></i>${b}</span>`).join('');
    $('leg2').innerHTML = lb([this.SOLID, ...this.JOINTS]) + `<span><i class="barf"></i>+ sense / axial</span><span><i class="barh"></i>− sense</span><span>† faded: still running or old input</span>`;
    $('leg3').innerHTML = lb([this.SOLID, ...this.JOINTS]);
  }

  drawAll() { this.drawBars(); this.drawRadar(); this.drawFD(); }

  // ----------------------------------------------------------------------------------------------------- bars
  drawBars() {
    const svg = $('bar'), wrap = $('barwrap'), tip = $('bartip'), D = this.D;
    if (!wrap.clientWidth) return;
    svg.innerHTML = '';
    const W = Math.max(420, wrap.clientWidth), L = 150, Rm = 56, T = 6, bh = 10, inner = 2, between = 7, pad = 12;
    const defs = el('defs', {}, svg);
    D.bodies.forEach(b => { const p = el('pattern', { id: 'h-' + b, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
      el('rect', { width: 6, height: 6, style: 'fill:var(--surface)' }, p); el('rect', { width: 3, height: 6, style: `fill:${this.col(b)}` }, p); });
    const x = v => L + (W - L - Rm) * Math.min(v, this.XMAX) / this.XMAX;
    const missLabel = r => r.rerun ? 'rerun pending' : r.state === 'not written' ? 'no input' : r.state;
    const rows = TYPES.map(([type, label]) => {
      const items = [], miss = {}, ks = this.keysOf(type);
      const s = this.R(this.SOLID, ks[0].key);
      if (s.state === 'complete') items.push({ body: this.SOLID, c: ks[0], r: s, solid: true });
      else (miss['solid ' + missLabel(s)] = miss['solid ' + missLabel(s)] || []).push('no reference');
      this.JOINTS.forEach(j => {
        const st = {};
        ks.forEach(c => { const r = this.R(j, c.key); if (this.usable(r)) items.push({ body: j, c, r }); else (st[missLabel(r)] = st[missLabel(r)] || []).push(c.sense); });
        Object.entries(st).forEach(([lab, sn]) => (miss[lab] = miss[lab] || []).push(sn.length === ks.length ? j : j + ' ' + sn.map(v => v === '-' ? '−' : '+').join('')));
      });
      return { type, label, items, miss: Object.entries(miss).map(([lab, names]) => `${lab}: ${names.join(', ')}`).join('  ·  ') };
    });
    let y = T; const placed = [];
    rows.forEach(row => {
      const top = y; y += pad;
      let lastBody = null;
      row.items.forEach(it => { if (lastBody !== null) y += it.body === lastBody ? inner : between; it.y = y; y += bh; lastBody = it.body; });
      if (row.miss) { if (row.items.length) y += 8; row.missY = y + 9; y += 12; }
      y = Math.max(y, top + pad + 30); y += pad; placed.push({ row, top, bottom: y });
    });
    const H = y + 24; svg.setAttribute('width', W); svg.setAttribute('height', H);
    for (let t = 0; t <= this.XMAX; t += 25) {
      el('line', { x1: x(t), x2: x(t), y1: T, y2: H - 22, style: `stroke:${t === 100 ? 'var(--axis)' : 'var(--grid)'}`, 'stroke-width': t === 100 ? 1.5 : 1 }, svg);
      el('text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = t + ' %';
    }
    const curType = this.view ? D.cases.find(c => c.key === this.view.key)?.type : null;
    placed.forEach(({ row, top, bottom }, i) => {
      if (row.type === curType) el('rect', { x: 0, y: top + 1, width: W - 8, height: bottom - top - 2, rx: 4, style: 'fill:var(--accent);fill-opacity:.07' }, svg);
      if (i) el('line', { x1: 0, x2: W - 8, y1: top, y2: top, style: 'stroke:var(--grid)' }, svg);
      el('text', { x: 0, y: top + pad + 10, class: row.type === curType ? 'cur' : 'ink' }, svg).textContent = row.label.replace(/ \(.*\)/, '');
      el('text', { x: 0, y: top + pad + 25 }, svg).textContent = MEAS[row.type];
      if (row.miss) el('text', { x: L + 4, y: row.missY, style: 'font-size:11px' }, svg).textContent = row.miss;
      row.items.forEach(it => {
        const r = it.r, val = it.solid ? 100 : (this.usable(r) ? r.score : null);
        if (val === null) return;
        const w = Math.max(2, x(val) - L), rr = Math.min(4, w / 2);
        const d = `M${L},${it.y} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${bh - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${w - rr} z`;
        const fill = it.c.sense === '-' && !it.solid ? `url(#h-${it.body})` : this.col(it.body);
        const dim = !it.solid && !this.inView(it.body), here = this.view && it.c.key === this.view.key && this.inView(it.body);
        el('path', { d, style: `fill:${fill};opacity:${(!this.stale(r) || it.solid ? 1 : 0.45) * (dim ? 0.22 : 1)}` + (here ? ';stroke:var(--fg);stroke-width:1.5' : '') }, svg);
        el('text', { x: x(val) + 6, y: it.y + 9, class: 'ink', style: 'font-size:11px' }, svg).textContent = (it.solid ? '100' : val.toFixed(1)) + (this.stale(r) ? ' †' : '');
        const hit = el('rect', { x: L, y: it.y - 2, width: Math.max(w + 40, 30), height: bh + 4, fill: 'transparent', tabindex: 0, class: 'click' }, svg);
        const show = () => tipAt(tip, wrap, x(val), it.y, `<b>${it.body}</b> · ${this.caseLabel(it.c)}<br>${it.solid ? 'reference, 100 %' : `${val.toFixed(1)} % of solid (${r.measure || MEAS[row.type]})`}${r.k !== undefined ? `<br>k = ${fmt(r.k)}` : ''}${it.solid ? '' : this.provisional(r)}<br><span style="color:var(--dim)">click: show it on the right</span>`);
        hit.addEventListener('mouseenter', show); hit.addEventListener('focus', show);
        hit.addEventListener('mouseleave', () => tip.hidden = true); hit.addEventListener('blur', () => tip.hidden = true);
        const go = () => this.h.onBar?.(it.body, it.c.key);
        hit.addEventListener('click', go); hit.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      });
    });
  }

  // ----------------------------------------------------------------------------------------------------- radar
  _radarCtl() {
    const ctl = $('radctl'), st = this.radState;
    const radHas = j => RAD_AX.some(([t]) => this.keysOf(t).some(c => this.usable(this.R(j, c.key))));
    this.radHas = radHas;
    ctl.innerHTML = `<div class="cchips" role="group" aria-label="Joints shown">${this.JOINTS.map(j => `<button data-j="${j}"${radHas(j) ? '' : ' disabled title="no complete run yet"'}><i class="key" style="background:${this.col(j)}"></i>${j}</button>`).join('')}</div>` +
      `<div class="seg" role="group" aria-label="Sense shown"><button data-s="both">+ and −</button><button data-s="+">+ only</button><button data-s="-">− only</button>` +
      `<button class="link" data-link title="linked: the radar shows the joints of the 3-D view, and these chips choose them there. Unlink to pick joints here on their own.">unlink</button></div>`;
    const save = () => { try { localStorage.setItem('jfea.radar', JSON.stringify(st)); } catch (e) {} };
    const sync = () => {
      const shown = this.radarShown();
      ctl.querySelectorAll('[data-j]').forEach(b => b.setAttribute('aria-pressed', shown.includes(b.dataset.j)));
      ctl.querySelectorAll('[data-s]').forEach(b => b.setAttribute('aria-pressed', b.dataset.s === st.sense));
      const lk = ctl.querySelector('[data-link]'); lk.setAttribute('aria-pressed', !st.link); lk.textContent = st.link ? 'unlink' : 'link';
      lk.title = st.link ? 'linked: the radar shows the joints of the 3-D view, and these chips choose them there. Click to pick joints here on their own.' : 'unlinked: the joints are picked here. Click to follow the 3-D view again.';
    };
    this._syncRadarCtl = sync;
    ctl.querySelectorAll('[data-j]').forEach(b => b.addEventListener('click', () => { const j = b.dataset.j;
      if (st.link && this.view && this.h.onJoint) { this.h.onJoint(j); return; }        // linked: the chip acts on the view
      st.off = st.off.includes(j) ? st.off.filter(x => x !== j) : [...st.off, j]; save(); sync(); this.drawRadar(); }));
    ctl.querySelector('[data-link]').addEventListener('click', () => {
      if (st.link) st.off = this.JOINTS.filter(j => !this.radarShown().includes(j));   // keep what is shown now as the free choice
      st.link = !st.link; save(); sync(); this.drawRadar(); });
    ctl.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => { st.sense = b.dataset.s; save(); sync(); this.drawRadar(); }));
    sync();
    const lineKey = (dash, hollow) => `<svg class="lkey" viewBox="0 0 22 10"><line x1="1" y1="5" x2="21" y2="5" stroke-width="2" style="stroke:var(--muted)"${dash ? ' stroke-dasharray="5 3"' : ''}/><circle cx="11" cy="5" r="3" stroke-width="2" style="fill:${hollow ? 'var(--surface)' : 'var(--muted)'};stroke:${hollow ? 'var(--muted)' : 'var(--surface)'}"/></svg>`;
    $('leg4').innerHTML = `<span>${lineKey(false, false)}+ sense / axial</span><span>${lineKey(true, true)}− sense</span>` +
      `<span><svg class="lkey" viewBox="0 0 22 10"><line x1="1" y1="5" x2="21" y2="5" stroke-width="2" style="stroke:${this.col(this.SOLID)}"/></svg>${this.SOLID} = 100 %</span>`;
  }

  drawRadar() {
    const svg = $('rad'), wrap = $('radwrap'), tip = $('radtip'), st = this.radState, n = RAD_AX.length;
    if (!wrap.clientWidth) return;
    svg.innerHTML = ''; tip.hidden = true;
    const radVal = (j, type, sense) => { const ks = this.keysOf(type), c = ks.length === 1 ? ks[0] : ks.find(k => k.sense === sense), r = this.R(j, c.key); return { v: this.usable(r) ? r.score : null, r, c }; };
    const W = Math.max(300, Math.min(wrap.clientWidth, 760)), narrow = W < 520, M = narrow ? 66 : 108, top = narrow ? 40 : 52;
    const availH = Math.max(320, ($('topic-body').clientHeight || 700) - 190);
    const Rpx = Math.max(70, Math.min((W - 2 * M) / 2, 230, (availH - top - 60) / (1 + Math.cos(Math.PI / n)))), cx = W / 2, cy = top + Rpx;
    const H = Math.round(cy + Rpx * Math.cos(Math.PI / n) + 54);
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    const ang = i => -Math.PI / 2 + 2 * Math.PI * i / n;
    const pt = (i, v) => { const r = Rpx * Math.min(Math.max(v, 0), this.XMAX) / this.XMAX; return [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))]; };
    const ring = v => RAD_AX.map((_, i) => pt(i, v).map(c => c.toFixed(1)).join(',')).join(' ');
    for (let t = 25; t <= this.XMAX; t += 25) if (t !== 100) el('polygon', { points: ring(t), fill: 'none', style: 'stroke:var(--grid)' }, svg);
    const spokes = RAD_AX.map((_, i) => { const [x, y] = pt(i, this.XMAX); return el('line', { x1: cx, y1: cy, x2: x, y2: y, style: 'stroke:var(--grid)' }, svg); });
    el('polygon', { points: ring(100), fill: 'none', style: `stroke:${this.col(this.SOLID)}`, 'stroke-width': 2 }, svg);
    RAD_AX.forEach(([t, lab], i) => {
      const a = ang(i), c = Math.cos(a), s = Math.sin(a), r = Rpx + (narrow ? 10 : 14), x = cx + r * c, y = cy + r * s;
      const lines = narrow ? (lab.startsWith('Bending ') ? ['Bending', lab.slice(8)] : [lab]) : [lab, MEAS[t]], lh = narrow ? 13 : 15;
      const anchor = Math.abs(c) < 0.3 ? 'middle' : c > 0 ? 'start' : 'end';
      const y0 = s < -0.5 ? y - 5 - lh * (lines.length - 1) : s > 0.5 ? y + 12 : y + 4 - lh * (lines.length - 1) / 2;
      const cur = this.view && this.D.cases.find(c => c.key === this.view.key)?.type === t;
      lines.forEach((txt, k) => el('text', { x, y: y0 + k * lh, 'text-anchor': anchor, class: k && !narrow ? (cur ? 'cur' : '') : (cur ? 'cur' : 'ink'), style: `font-size:${narrow || k ? 11 : 12}px` }, svg).textContent = txt);
      if (cur) { spokes[i].style.stroke = 'var(--accent)'; spokes[i].setAttribute('stroke-width', 1.5); spokes[i].dataset.cur = 1; }
    });
    const senses = st.sense === 'both' ? ['+', '-'] : [st.sense];
    const shown = this.radarShown();
    const curType = this.view ? this.D.cases.find(c => c.key === this.view.key)?.type : null;
    const gF = el('g', {}, svg), gL = el('g', {}, svg), gM = el('g', {}, svg), gH = el('g', {}, svg);
    if (!shown.length) el('text', { x: cx, y: cy - 8, 'text-anchor': 'middle' }, svg).textContent = this.JOINTS.some(this.radHas) ? 'no joint selected' : 'no complete joint run yet';
    shown.forEach(j => senses.forEach(s => {
      const V = RAD_AX.map(([t]) => radVal(j, t, s)), P = V.map((d, i) => d.v === null ? null : pt(i, d.v));
      if (shown.length === 1 && s === senses[0] && V.every(d => d.v !== null))
        el('polygon', { points: P.map(p => p.join(',')).join(' '), style: `fill:${this.col(j)};fill-opacity:.08;stroke:none` }, gF);
      for (let i = 0; i < n; i++) { const k = (i + 1) % n; if (!P[i] || !P[k]) continue;
        const a = { x1: P[i][0], y1: P[i][1], x2: P[k][0], y2: P[k][1], 'stroke-width': 2, 'stroke-linecap': 'round', style: `stroke:${this.col(j)};opacity:${this.stale(V[i].r) || this.stale(V[k].r) ? .45 : 1}` };
        if (s === '-') a['stroke-dasharray'] = '6 4';
        el('line', a, gL); }
      V.forEach((d, i) => { if (d.v === null) return;
        const axial = this.keysOf(RAD_AX[i][0]).length === 1; if (axial && s !== senses[0]) return;
        const hollow = s === '-' && !axial;
        el('circle', { cx: P[i][0], cy: P[i][1], r: 4, 'stroke-width': 2, style: `fill:${hollow ? 'var(--surface)' : this.col(j)};stroke:${hollow ? this.col(j) : 'var(--surface)'};opacity:${this.stale(d.r) ? .45 : 1}` }, gM); });
    }));
    const ab = -Math.PI / 2 - Math.PI / n;
    for (let t = 25; t <= this.XMAX; t += 25) { const r = Rpx * t / this.XMAX * Math.cos(Math.PI / n);
      el('text', { x: cx + r * Math.cos(ab) - 3, y: cy + r * Math.sin(ab) + 4, 'text-anchor': 'end', style: 'font-size:11px;fill:var(--faint);paint-order:stroke;stroke:var(--surface);stroke-width:3px;stroke-linejoin:round' }, svg).textContent = t === 100 ? '100 %' : t; }
    const baseStroke = l => l.dataset.cur ? 'var(--accent)' : 'var(--grid)';
    const hide = () => { tip.hidden = true; spokes.forEach(l => l.style.stroke = baseStroke(l)); };
    RAD_AX.forEach(([t, lab], i) => {
      const a1 = ang(i) - Math.PI / n, a2 = ang(i) + Math.PI / n, rr = Rpx + 12;
      const d = `M${cx},${cy} L${cx + rr * Math.cos(a1)},${cy + rr * Math.sin(a1)} A${rr},${rr} 0 0 1 ${cx + rr * Math.cos(a2)},${cy + rr * Math.sin(a2)} Z`;
      const w = el('path', { d, fill: 'transparent', tabindex: 0, 'aria-label': lab, class: 'click' }, gH);
      const show = () => {
        spokes.forEach((l, k) => l.style.stroke = k === i ? 'var(--axis)' : baseStroke(l));
        const axial = this.keysOf(t).length === 1;
        const rows = shown.map(j => `<i class="key" style="background:${this.col(j)}"></i> ${j}: ` + (axial ? [null] : senses).map(s => {
          const v = radVal(j, t, s || '+'), txt = v.v === null ? (v.r.rerun ? 'rerun pending' : v.r.state === 'not written' ? '—' : v.r.state) : `${v.v.toFixed(1)} %${this.stale(v.r) ? ' †' : ''}`;
          return (s ? (s === '-' ? '− ' : '+ ') : '') + txt; }).join(' · '));
        const [x, y] = pt(i, Math.min(this.XMAX, 100));
        tipAt(tip, wrap, x + svg.getBoundingClientRect().left - wrap.getBoundingClientRect().left, y, `<b>${lab.replace(' ±', '')}</b> · % of solid (${MEAS[t]})<br>${rows.join('<br>') || 'no joint shown'}<br><span style="color:var(--dim)">click: compare the joints in this case</span>`);
      };
      w.addEventListener('mouseenter', show); w.addEventListener('focus', show);
      w.addEventListener('mouseleave', hide); w.addEventListener('blur', hide);
      const go = () => this.h.onAxis?.(t, st.sense === '-' ? '-' : '+');
      w.addEventListener('click', go); w.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
  }

  // ----------------------------------------------------------------------------------------------------- F–d
  _tabs() {
    const tabs = $('tabs');
    this.D.cases.forEach(c => { const b = document.createElement('button'); b.dataset.key = c.key; b.textContent = this.caseLabel(c); b.disabled = !this.withCurve(c);
      b.setAttribute('aria-pressed', c.key === this.cur);
      b.onclick = () => { this.setCase(c.key); this.h.onCase?.(c.key); };
      tabs.appendChild(b); });
  }
  setCase(key) {
    if (!this.D.cases.some(c => c.key === key)) return;
    this.cur = key;
    [...$('tabs').children].forEach(x => x.setAttribute('aria-pressed', x.dataset.key === key));
    this.drawFD();
  }

  drawFD() {
    const svg = $('fd'), wrap = $('fdwrap'), tip = $('fdtip'), D = this.D, cur = this.cur;
    if (!wrap.clientWidth) return;
    svg.innerHTML = '';
    const c = D.cases.find(x => x.key === cur), ax = AX[c.type];
    const W = Math.max(420, wrap.clientWidth), H = Math.max(280, Math.min(560, ($('topic-body').clientHeight || 600) - 190)), L = 74, Rm = 168, T = 14, B = 42;
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    const bodies = D.bodies.filter(b => (this.R(b, cur).u || []).length);
    if (!bodies.length) { el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, svg).textContent = 'no curve for this case'; return; }
    const umax = nice(Math.max(...bodies.map(b => Math.max(...this.R(b, cur).u)))) || 1;
    const fmax = nice(Math.max(...bodies.map(b => Math.max(...this.R(b, cur).F))) * 1.04);
    const x = u => L + (W - L - Rm) * u / umax, y = f => T + (H - T - B) * (1 - f / fmax);
    this.fdScale = { x, y };
    for (let i = 0; i <= 4; i++) { const f = fmax * i / 4; el('line', { x1: L, x2: W - Rm, y1: y(f), y2: y(f), style: `stroke:${i ? 'var(--grid)' : 'var(--axis)'}` }, svg);
      el('text', { x: L - 8, y: y(f) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(f); }
    for (let i = 0; i <= 4; i++) { const u = umax * i / 4; el('text', { x: x(u), y: H - B + 18, 'text-anchor': 'middle' }, svg).textContent = +u.toPrecision(3); }
    el('text', { x: (L + W - Rm) / 2, y: H - 4, 'text-anchor': 'middle' }, svg).textContent = ax[0];
    const ym = T + (H - T - B) / 2; el('text', { x: 14, y: ym, 'text-anchor': 'middle', transform: `rotate(-90 14 ${ym})` }, svg).textContent = ax[1];
    const ends = [];
    bodies.forEach(b => { const r = this.R(b, cur); const pts = [[0, 0], ...r.u.map((u, i) => [u, r.F[i]])];
      const dim = b !== this.SOLID && !this.inView(b) ? 0.25 : 1;
      el('polyline', { points: pts.map(([u, f]) => `${x(u)},${y(f)}`).join(' '), fill: 'none', style: `stroke:${this.col(b)};opacity:${(!this.stale(r) ? 1 : .55) * dim}`, 'stroke-width': dim < 1 ? 1.5 : 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      const [ue, fe] = pts[pts.length - 1];
      el('circle', { cx: x(ue), cy: y(fe), r: 4.5, style: `fill:${this.col(b)};stroke:var(--surface);opacity:${dim}`, 'stroke-width': 2 }, svg);
      ends.push({ b, xe: x(ue), ye: y(fe), fe, r }); });
    ends.sort((p, q) => p.ye - q.ye); let last = -1e9;
    ends.forEach(e => { const yy = Math.max(e.ye + 4, last + 15); last = yy;
      if (Math.abs(yy - e.ye - 4) > 3) el('line', { x1: e.xe + 6, y1: e.ye, x2: W - Rm + 6, y2: yy - 4, style: 'stroke:var(--axis)' }, svg);
      const lab = el('text', { x: Math.max(e.xe, W - Rm) + 10, y: yy, class: 'ink click' }, svg);
      lab.textContent = `${e.b} ${fmt(e.fe)}${e.r.state !== 'complete' ? ` (t=${e.r.t})` : ''}`;
      lab.addEventListener('click', () => this.h.onBar?.(e.b, cur)); });
    this.gMark = el('g', {}, svg);
    const vline = el('line', { y1: T, y2: H - B, style: 'stroke:var(--faint)', visibility: 'hidden' }, svg);
    const ov = el('rect', { x: L, y: T, width: W - L - Rm, height: H - T - B, fill: 'transparent' }, svg);
    ov.addEventListener('mousemove', ev => { const rc = svg.getBoundingClientRect(), mx = ev.clientX - rc.left, u = Math.max(0, Math.min(umax, (mx - L) / (W - L - Rm) * umax));
      vline.setAttribute('x1', x(u)); vline.setAttribute('x2', x(u)); vline.setAttribute('visibility', 'visible');
      const lines = bodies.map(b => { const r = this.R(b, cur), us = [0, ...r.u], Fs = [0, ...r.F];
        if (u > us[us.length - 1] + 1e-12) return `<span style="color:var(--faint)">${b}: run ends at ${+us[us.length - 1].toPrecision(3)}</span>`;
        let i = 1; while (i < us.length - 1 && us[i] < u) i++; const f = Fs[i - 1] + (Fs[i] - Fs[i - 1]) * (u - us[i - 1]) / ((us[i] - us[i - 1]) || 1);
        return `<i class="key" style="background:${this.col(b)};margin-right:5px"></i>${b}: ${fmt(f)}`; });
      tipAt(tip, wrap, mx, ev.clientY - rc.top, `<b>${+u.toPrecision(3)}</b> ${ax[0].replace(/ \[.*/, '')}<br>${lines.join('<br>')}`); });
    ov.addEventListener('mouseleave', () => { tip.hidden = true; vline.setAttribute('visibility', 'hidden'); });
    const sc = this.JOINTS.filter(j => this.usable(this.R(j, cur))).map(j => `${j} ${this.R(j, cur).score.toFixed(1)} %${this.provisional(this.R(j, cur))}`);
    $('fdnote').textContent = sc.length ? `% of solid (${MEAS[c.type]}): ${sc.join(' · ')}` : '';
    this._drawMarkers();
  }

  /** rings on the F–d curves at the increment shown on the right: [{body, key, u, F}] */
  setMarkers(list) { this.markers = list || []; this._drawMarkers(); }
  _drawMarkers() {
    const g = this.gMark; if (!g || !this.fdScale) return;
    g.innerHTML = '';
    for (const m of this.markers) {
      if (m.key !== this.cur || !Number.isFinite(m.u) || !Number.isFinite(m.F)) continue;
      const cx = this.fdScale.x(Math.abs(m.u)), cy = this.fdScale.y(Math.abs(m.F));
      el('circle', { cx, cy, r: 8, fill: 'none', style: `stroke:${this.col(m.body)}`, 'stroke-width': 2.5 }, g);
      el('circle', { cx, cy, r: 2.5, style: `fill:${this.col(m.body)}` }, g);
    }
  }

  /** u, F of a body's curve at load time t, using the frame times and the curve rows they map to */
  curveAt(body, key, times, cidx, t) {
    const r = this.R(body, key); if (!r.u || !r.u.length || !times) return null;
    const U = [0, ...r.u], F = [0, ...r.F];
    const at = (i) => { const k = cidx[i]; return k === null || k === undefined || k < 0 || k >= U.length ? null : [U[k], F[k]]; };
    const n = times.length;
    if (t >= times[n - 1]) { const p = at(n - 1); return p && { u: p[0], F: p[1] }; }
    let i = 0; while (i < n - 2 && times[i + 1] < t) i++;
    const a = at(i), b = at(i + 1); if (!a || !b) return null;
    const m = Math.max(0, Math.min(1, (t - times[i]) / Math.max(times[i + 1] - times[i], 1e-9)));
    return { u: a[0] + (b[0] - a[0]) * m, F: a[1] + (b[1] - a[1]) * m };
  }
}
