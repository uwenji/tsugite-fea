// Loads what web_export.py writes: index.json, compare.json, mesh_*.bin and <joint>_<case>.bin.
// Binary layout: magic(4) | version u32 | json length u32 | json | arrays (each 4-byte aligned, offsets in the json).

const TYPED = { float32: Float32Array, uint32: Uint32Array, uint16: Uint16Array, uint8: Uint8Array, int32: Int32Array };

async function fetchBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  let buf = await r.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {                  // gzip (e.g. served as .bin.gz)
    buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return buf;
}

function parseBin(buf, url) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  const n = dv.getUint32(8, true);
  const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, n)).replace(/\0+$/, ''));
  const arrays = {};
  for (const a of hdr.arrays) {
    const T = TYPED[a.dtype]; if (!T) throw new Error(`${url}: dtype ${a.dtype}`);
    arrays[a.name] = new T(buf, a.offset, a.bytes / T.BYTES_PER_ELEMENT);
  }
  return { magic, hdr, arrays };
}

export class Store {
  constructor(base = 'data/') { this.base = base; this.meshes = new Map(); this.cases = new Map(); this.pending = new Map(); }

  async init() {
    const [index, compare] = await Promise.all([
      fetch(this.base + 'index.json').then(r => { if (!r.ok) throw new Error('data/index.json missing - run python web_export.py'); return r.json(); }),
      fetch(this.base + 'compare.json').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    this.index = index; this.compare = compare;
    return this;
  }

  has(name) { return !!this.index.cases[name]; }

  _once(key, fn) {
    if (this.pending.has(key)) return this.pending.get(key);
    const p = fn().finally(() => this.pending.delete(key));
    this.pending.set(key, p); return p;
  }

  async mesh(file) {
    if (this.meshes.has(file)) return this.meshes.get(file);
    return this._once(file, async () => {
      const { hdr, arrays: a } = parseBin(await fetchBin(this.base + file), file);
      const m = {
        name: file, joint: hdr.joint, nNodes: hdr.n_nodes, nTets: hdr.n_tets, nTris: hdr.n_tris, nEdges: hdr.n_edges,
        bodies: hdr.bodies, lo: hdr.lo, hi: hdr.hi, meta: hdr.meta || {}, triRanges: hdr.tri_ranges,
        P: a.P, tets: a.tets, tetBody: a.tet_body, tri: a.tri, triBody: a.tri_body, triClass: a.tri_class, edges: a.edges, edgeBody: a.edge_body,
      };
      this.meshes.set(file, m); return m;
    });
  }

  async case(name) {
    if (this.cases.has(name)) return this.cases.get(name);
    const info = this.index.cases[name]; if (!info) throw new Error(`no exported case ${name}`);
    return this._once(name, async () => {
      const [bin, mesh] = await Promise.all([fetchBin(this.base + info.file), this.mesh(info.mesh)]);
      const { hdr, arrays: a } = parseBin(bin, info.file);
      const c = {
        name, joint: hdr.joint, key: hdr.case, mesh, nFrames: hdr.n_frames, nNodes: hdr.n_nodes, times: hdr.times, curveIndex: hdr.curve_index,
        stats: hdr.stats, args: hdr.args, control: hdr.control, channels: hdr.channels,
        ranges: a.ranges, frames: new Uint32Array(a.frames.buffer, a.frames.byteOffset, a.frames.byteLength / 4), q: a.frames,
        cache: new Map(),
      };
      this.cases.set(name, c);
      if (this.cases.size > 24) {                                  // keep the CPU copies bounded
        for (const k of this.cases.keys()) { if (this.cases.size <= 24) break; if (k !== name) this.cases.delete(k); }
      }
      return c;
    });
  }
}

// ---------------------------------------------------------------------------------------------------------- fields
// The same codes as the shader (shaders.js fieldF). unit '' = dimensionless; kind: seq | div (signed, centred on 0) | none
export const FIELDS = [
  { id: 'GEOM', code: -1, label: 'geometry (no field)', unit: '', kind: 'none' },
  { id: 'U', code: 0, label: '|U| displacement', unit: 'mm', kind: 'seq', group: 'Displacement' },
  { id: 'U1', code: 1, label: 'U_x', unit: 'mm', kind: 'div', group: 'Displacement' },
  { id: 'U2', code: 2, label: 'U_y (along the bar)', unit: 'mm', kind: 'div', group: 'Displacement' },
  { id: 'U3', code: 3, label: 'U_z', unit: 'mm', kind: 'div', group: 'Displacement' },
  { id: 'MISES', code: 4, label: 'von Mises stress', unit: 'MPa', kind: 'seq', group: 'Stress' },
  { id: 'SYY', code: 6, label: 'σ along the grain (S_YY)', unit: 'MPa', kind: 'div', group: 'Stress' },
  { id: 'SZZ', code: 7, label: 'σ across the grain, radial (S_ZZ)', unit: 'MPa', kind: 'div', group: 'Stress' },
  { id: 'SXX', code: 5, label: 'σ across the grain, tangential (S_XX)', unit: 'MPa', kind: 'div', group: 'Stress' },
  { id: 'SYZ', code: 9, label: 'τ_LR shear along the grain (S_YZ)', unit: 'MPa', kind: 'div', group: 'Stress' },
  { id: 'SXY', code: 8, label: 'τ_LT shear along the grain (S_XY)', unit: 'MPa', kind: 'div', group: 'Stress' },
  { id: 'SZX', code: 10, label: 'τ_RT rolling shear (S_ZX)', unit: 'MPa', kind: 'div', group: 'Stress' },
  { id: 'S1', code: 11, label: 'max principal stress', unit: 'MPa', kind: 'div', group: 'Stress' },
  { id: 'S3', code: 12, label: 'min principal stress', unit: 'MPa', kind: 'div', group: 'Stress' },
  { id: 'TRESCA', code: 16, label: 'Tresca (σ1 − σ3)', unit: 'MPa', kind: 'seq', group: 'Stress' },
  { id: 'CPRESS', code: 13, label: 'contact pressure', unit: 'MPa', kind: 'seq', group: 'Contact', contact: true },
  { id: 'COPEN', code: 14, label: 'contact opening', unit: 'mm', kind: 'div', group: 'Contact', contact: true },
  { id: 'CSLIP', code: 15, label: 'contact slip', unit: 'mm', kind: 'seq', group: 'Contact', contact: true },
];
export const fieldById = (id) => FIELDS.find(f => f.id === id) || FIELDS[5];

function decode(c, f, n, ch) {
  const w = c.q[(f * c.nNodes + n) * 12 + ch] / 65535, r = (f * 12 + ch) * 2;
  return c.ranges[r] + w * (c.ranges[r + 1] - c.ranges[r]);
}

/** field values of every node at frame f (Float32Array), cached */
export function fieldValues(c, fieldId, f) {
  const key = fieldId + '|' + f;
  if (c.cache.has(key)) return c.cache.get(key);
  const F = fieldById(fieldId), N = c.nNodes, out = new Float32Array(N);
  const g = (n, ch) => decode(c, f, n, ch);
  for (let n = 0; n < N; n++) {
    switch (F.code) {
      case 0: out[n] = Math.hypot(g(n, 0), g(n, 1), g(n, 2)); break;
      case 1: case 2: case 3: out[n] = g(n, F.code - 1); break;
      case 5: case 6: case 7: case 8: case 9: case 10: out[n] = g(n, F.code - 2); break;
      case 13: case 14: case 15: out[n] = g(n, F.code - 4); break;
      default: {
        const sxx = g(n, 3), syy = g(n, 4), szz = g(n, 5), sxy = g(n, 6), syz = g(n, 7), szx = g(n, 8);
        if (F.code === 4) { out[n] = Math.sqrt(Math.max(0, 0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * (sxy * sxy + syz * syz + szx * szx))); break; }
        const e = principal(sxx, syy, szz, sxy, syz, szx);
        out[n] = F.code === 11 ? e[0] : F.code === 12 ? e[2] : e[0] - e[2];
      }
    }
  }
  c.cache.set(key, out);
  return out;
}

export function principal(sxx, syy, szz, sxy, syz, szx) {
  const p1 = sxy * sxy + syz * syz + szx * szx, q = (sxx + syy + szz) / 3;
  if (p1 < 1e-18 * (1 + q * q)) { const s = [sxx, syy, szz].sort((a, b) => b - a); return s; }
  const p2 = (sxx - q) ** 2 + (syy - q) ** 2 + (szz - q) ** 2 + 2 * p1, p = Math.sqrt(p2 / 6);
  const b11 = (sxx - q) / p, b22 = (syy - q) / p, b33 = (szz - q) / p, b12 = sxy / p, b23 = syz / p, b13 = szx / p;
  const det = b11 * (b22 * b33 - b23 * b23) - b12 * (b12 * b33 - b23 * b13) + b13 * (b12 * b23 - b22 * b13);
  const phi = Math.acos(Math.max(-1, Math.min(1, det / 2))) / 3;
  const e1 = q + 2 * p * Math.cos(phi), e3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
  return [e1, 3 * q - e1 - e3, e3];
}

/** colour range of a field at frame f: 'robust' = 1st–99th percentile, 'full' = min–max; contact fields count only the
 *  nodes that carry a value. Signed fields come back symmetric about 0. */
export function fieldRange(c, fieldId, f, mode) {
  const key = 'R|' + fieldId + '|' + f + '|' + mode;
  if (c.cache.has(key)) return c.cache.get(key);
  const F = fieldById(fieldId), v = fieldValues(c, fieldId, f);
  let arr = v;
  if (F.contact) arr = v.filter(x => Math.abs(x) > 1e-12);
  let lo = 0, hi = 0;
  if (arr.length) {
    if (mode === 'robust' && arr.length > 50) {
      const s = Float32Array.from(arr).sort();
      lo = s[Math.floor(0.01 * (s.length - 1))]; hi = s[Math.ceil(0.99 * (s.length - 1))];
    } else { lo = Infinity; hi = -Infinity; for (const x of arr) { if (x < lo) lo = x; if (x > hi) hi = x; } }
  }
  if (F.kind === 'div') { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
  else if (F.kind === 'seq' && lo > 0 && (F.code === 0 || F.contact || F.code === 4 || F.code === 16)) lo = 0;
  const r = [lo, hi];
  c.cache.set(key, r);
  return r;
}

/** frames bracketing load time t: {f0, f1, mix, tEnd, clamped} */
export function frameAt(c, t) {
  const T = c.times, n = T.length, tEnd = T[n - 1];
  if (t >= tEnd) return { f0: n - 1, f1: n - 1, mix: 0, tEnd, clamped: t > tEnd + 1e-6 };
  let i = 0; while (i < n - 2 && T[i + 1] < t) i++;
  const m = (t - T[i]) / Math.max(T[i + 1] - T[i], 1e-9);
  return { f0: i, f1: i + 1, mix: Math.max(0, Math.min(1, m)), tEnd, clamped: false };
}
