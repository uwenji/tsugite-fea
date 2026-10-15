// The test rig drawn around the specimen, from the load case: line supports and spreader loads for the four-point
// bending cases, grips for tension / shear / torsion, the push on the upper platen in compression (the platens
// themselves are part of the mesh). Load arrows are anchored to a node, so they ride along with the deformed bar.
// Output: interleaved vertex data for gpu.js (pos f32x3, normal f32x3, colour unorm8x4, anchor u32) = 32 bytes.

const NO_ANCHOR = 0xFFFFFFFF;

class Builder {
  constructor() { this.f = []; this.count = 0; }
  tri(a, b, c, col, anc = NO_ANCHOR, n) {
    if (!n) { const u = sub(b, a), v = sub(c, a); n = norm(cross(u, v)); }
    for (const p of [a, b, c]) { this.f.push(p[0], p[1], p[2], n[0], n[1], n[2], col, anc); this.count++; }
  }
  quad(a, b, c, d, col, anc) { this.tri(a, b, c, col, anc); this.tri(a, c, d, col, anc); }
  box(lo, hi, col, anc) {
    const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
    const P = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
    const faces = [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5]];
    for (const q of faces) this.quad(P(q[0]), P(q[1]), P(q[2]), P(q[3]), col, anc);
  }
  /** cylinder from a to b, radius r */
  tube(a, b, r, col, anc, seg = 14) {
    const ax = norm(sub(b, a)), [e1, e2] = basis(ax);
    for (let i = 0; i < seg; i++) {
      const t0 = 2 * Math.PI * i / seg, t1 = 2 * Math.PI * (i + 1) / seg;
      const d0 = add(scale(e1, Math.cos(t0)), scale(e2, Math.sin(t0))), d1 = add(scale(e1, Math.cos(t1)), scale(e2, Math.sin(t1)));
      const p0 = add(a, scale(d0, r)), p1 = add(a, scale(d1, r)), q0 = add(b, scale(d0, r)), q1 = add(b, scale(d1, r));
      this.tri(p0, p1, q1, col, anc, norm(add(d0, d1))); this.tri(p0, q1, q0, col, anc, norm(add(d0, d1)));
    }
  }
  cone(base, tip, r, col, anc, seg = 18) {
    const ax = norm(sub(tip, base)), [e1, e2] = basis(ax), h = len(sub(tip, base));
    for (let i = 0; i < seg; i++) {
      const t0 = 2 * Math.PI * i / seg, t1 = 2 * Math.PI * (i + 1) / seg;
      const d0 = add(scale(e1, Math.cos(t0)), scale(e2, Math.sin(t0))), d1 = add(scale(e1, Math.cos(t1)), scale(e2, Math.sin(t1)));
      const p0 = add(base, scale(d0, r)), p1 = add(base, scale(d1, r));
      const nm = norm(add(scale(norm(add(d0, d1)), h), scale(ax, r)));
      this.tri(p0, p1, tip, col, anc, nm);
      this.tri(base, p1, p0, col, anc, scale(ax, -1));
    }
  }
  arrow(tail, tip, col, anc, r = 1.6, head = 10, headR = 4.4) {
    const ax = norm(sub(tip, tail)), L = len(sub(tip, tail)), hb = add(tail, scale(ax, Math.max(0, L - head)));
    this.tube(tail, hb, r, col, anc); this.cone(hb, tip, headR, col, anc);
  }
  /** triangular prism: apex line through `apex` along `along` (half length hl), body toward `dir`, height h, half base b */
  wedge(apex, along, dir, hl, h, b, col) {
    const side = norm(cross(along, dir));
    const A = (s) => add(apex, scale(along, s * hl));
    const B = (s, k) => add(add(apex, scale(dir, h)), add(scale(side, k * b), scale(along, s * hl)));
    this.quad(A(-1), A(1), B(1, 1), B(-1, 1), col); this.quad(A(1), A(-1), B(-1, -1), B(1, -1), col);
    this.quad(B(-1, 1), B(1, 1), B(1, -1), B(-1, -1), col);
    this.tri(A(-1), B(-1, 1), B(-1, -1), col); this.tri(A(1), B(1, -1), B(1, 1), col);
  }
  /** curved arrow round axis through c (unit ax), radius R, from angle a0 to a1 (rad, sign = sense) */
  arc(c, ax, R, a0, a1, col, anc, r = 1.6) {
    const [e1, e2] = basis(ax), n = 28, pt = (a) => add(c, add(scale(e1, R * Math.cos(a)), scale(e2, R * Math.sin(a))));
    const span = a1 - a0, headA = Math.sign(span) * 10 / R;
    for (let i = 0; i < n; i++) this.tube(pt(a0 + (span - headA) * i / n), pt(a0 + (span - headA) * (i + 1) / n), r, col, anc, 10);
    this.cone(pt(a1 - headA), pt(a1), 4.4, col, anc);
  }
  result() {
    const buf = new ArrayBuffer(this.count * 32), f = new Float32Array(buf), u = new Uint32Array(buf);
    for (let i = 0; i < this.count; i++) {
      const s = this.f.slice(i * 8, i * 8 + 8);
      f.set(s.slice(0, 6), i * 8); u[i * 8 + 6] = s[6] >>> 0; u[i * 8 + 7] = s[7] >>> 0;
    }
    return { buf, count: this.count };
  }
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function basis(ax) { const t = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; const e1 = norm(cross(ax, t)); return [e1, cross(ax, e1)]; }
const rgba = (rgb, a) => ((Math.round(a * 255) << 24) | (Math.round(rgb[2] * 255) << 16) | (Math.round(rgb[1] * 255) << 8) | Math.round(rgb[0] * 255)) >>> 0;

function nearestNode(P, q, filter) {
  let best = NO_ANCHOR, bd = Infinity;
  for (let i = 0, n = P.length / 3; i < n; i++) {
    const d = (P[3 * i] - q[0]) ** 2 + (P[3 * i + 1] - q[1]) ** 2 + (P[3 * i + 2] - q[2]) ** 2;
    if (d < bd && (!filter || filter(i))) { bd = d; best = i; }
  }
  return best;
}

/** c: case (data.js), type: compression|tension|shear_z|..., colours {load, support, grip} as rgb arrays */
export function buildRig(c, type, colors) {
  const m = c.mesh, lo = m.lo, hi = m.hi, P = m.P, B = new Builder();
  const hx = (hi[0] - lo[0]) / 2, hz = (hi[2] - lo[2]) / 2, y1 = hi[1], y0 = lo[1];
  const ctrl = c.control || [], args = c.args || {};
  const val = typeof ctrl[2] === 'number' ? ctrl[2] : (args.sense || 1);
  const s = Math.sign(val) || 1;
  const LOAD = rgba(colors.load, 1), SUP = rgba(colors.support, 1), GRIP = rgba(colors.grip, 0.30);
  const clampLen = (m.meta && m.meta.clamp_len) || 45, gap = 1.5, AL = 34;
  const grips = () => {
    const pad = 2.5;
    B.box([-hx - pad, y1 - clampLen, -hz - pad], [hx + pad, y1 + 3, hz + pad], GRIP, nearestNode(P, [0, y1, 0]));
    B.box([-hx - pad, y0 - 3, -hz - pad], [hx + pad, y0 + clampLen, hz + pad], GRIP);
  };
  if (type === 'bending' || type === 'bending_edge') {
    const ax = type === 'bending' ? 2 : 0, h = ax === 2 ? hz : hx, w = ax === 2 ? hx : hz;
    const Ls = args.Ls || 360, Ll = args.Ll || 200;
    const along = ax === 2 ? [1, 0, 0] : [0, 0, 1];
    const e = [0, 0, 0]; e[ax] = 1;
    for (const ys of [-Ls / 2, Ls / 2]) {          // line supports on the far face, wedges pointing at the bar
      const apex = [0, ys, 0]; apex[ax] = s * h;
      B.wedge(apex, along, scale(e, s), w + 6, 11, 6, SUP);
    }
    for (const yl of [-Ll / 2, Ll / 2]) {          // spreader loads on the near face, riding with the bar
      const face = [0, yl, 0]; face[ax] = -s * h;
      const tip = add(face, scale(e, -s * gap)), tail = add(face, scale(e, -s * (gap + AL)));
      B.arrow(tail, tip, LOAD, nearestNode(P, face));
    }
  } else if (type === 'compression') {
    const tools = m.bodies.map((b, i) => [b, i]).filter(([b]) => b.role === 'tool');
    const top = tools.length ? Math.max(...tools.map(([b]) => b.hi[1])) : y1;
    const end = s < 0 ? top : (tools.length ? Math.min(...tools.map(([b]) => b.lo[1])) : y0);
    const dir = [0, s, 0], tip = [0, end - s * gap, 0], tail = add(tip, scale(dir, -AL - 6));
    B.arrow(tail, tip, LOAD, nearestNode(P, [0, end, 0]), 2.2, 12, 6);
  } else if (type === 'tension') {
    grips();
    const base = [0, y1 + 5, 0];
    B.arrow(base, add(base, [0, AL + 6, 0]), LOAD, nearestNode(P, [0, y1, 0]), 2.2, 12, 6);
  } else if (type === 'shear_z' || type === 'shear_x') {
    grips();
    const ax = type === 'shear_z' ? 2 : 0, h = (ax === 2 ? hz : hx) + 2.5;
    const e = [0, 0, 0]; e[ax] = 1;
    const face = [0, y1 - clampLen / 2, 0]; face[ax] = -s * h;
    B.arrow(add(face, scale(e, -s * (gap + AL))), add(face, scale(e, -s * gap)), LOAD, nearestNode(P, [0, y1, 0]));
  } else if (type === 'torsion') {
    grips();
    const R = Math.hypot(hx, hz) + 8, sense = Math.sign(args.sense || val) || 1;
    B.arc([0, y1 + 8, 0], [0, 1, 0], R, 0.6, 0.6 + sense * 4.4, LOAD, nearestNode(P, [0, y1, 0]));
  }
  return B.result();
}
