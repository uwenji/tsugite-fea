// WGSL for the FEA view. Everything is fetched from storage buffers by vertex_index (no vertex buffers except the rig):
//   P   base positions of the corner nodes (f32 x3)
//   FR  per frame and node: 12 channels as unorm16 pairs (6 u32): U1 U2 U3 | SXX SYY SZZ SXY SYZ SZX | CPRESS COPEN CSLIP
//   RG  per frame and channel: lo, hi of the quantisation
//   LUT 256 colours of the active colour map
// Displacement and field are interpolated between two frames (f0, f1, mix) so the loading animates smoothly.
export const COMMON = /* wgsl */`
struct U {
  viewProj : mat4x4f,
  eye      : vec4f,      // xyz: camera position (persp) or direction toward the camera (ortho); w: 1 = ortho
  clip     : vec4f,      // keep dot(p, n) <= d
  fr       : vec4f,      // f0, f1, mix, deformation scale
  fld      : vec4f,      // field code, lo, hi, bands
  opt      : vec4f,      // clip on, skin alpha, geometry colours, node count
  light    : vec4f,      // xyz: camera up (light comes from above the view), w: ambient
  misc     : vec4f,      // x: section cap shade, y: pick id, z: highlight body (-1 none), w: depth pull for lines
  edgeCol  : vec4f,
  bodyOff  : array<vec4f, 8>,   // xyz explode offset, w: visible
  bodyCol  : array<vec4f, 8>,   // rgb geometry colour, w: 1 = always this colour (tools)
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var<storage, read> P : array<f32>;
@group(0) @binding(2) var<storage, read> FR : array<u32>;
@group(0) @binding(3) var<storage, read> RG : array<f32>;
@group(0) @binding(4) var<storage, read> LUT : array<vec4f>;

fn ch(f : u32, n : u32, c : u32) -> f32 {
  let nn = u32(u.opt.w);
  let w = FR[(f * nn + n) * 6u + (c >> 1u)];
  let v = unpack2x16unorm(w);
  let q = select(v.x, v.y, (c & 1u) == 1u);
  let r = (f * 12u + c) * 2u;
  return RG[r] + q * (RG[r + 1u] - RG[r]);
}
fn dispF(f : u32, n : u32) -> vec3f { return vec3f(ch(f, n, 0u), ch(f, n, 1u), ch(f, n, 2u)); }
fn disp(n : u32) -> vec3f { return mix(dispF(u32(u.fr.x), n), dispF(u32(u.fr.y), n), u.fr.z); }
fn basePos(n : u32) -> vec3f { return vec3f(P[3u * n], P[3u * n + 1u], P[3u * n + 2u]); }
fn defPos(n : u32) -> vec3f { return basePos(n) + u.fr.w * disp(n); }

fn principal(sxx : f32, syy : f32, szz : f32, sxy : f32, syz : f32, szx : f32) -> vec3f {
  let p1 = sxy * sxy + syz * syz + szx * szx;
  let q = (sxx + syy + szz) / 3.0;
  if (p1 < 1e-18 * (1.0 + q * q)) {
    let a = max(max(sxx, syy), szz); let c = min(min(sxx, syy), szz);
    return vec3f(a, sxx + syy + szz - a - c, c);
  }
  let p2 = (sxx - q) * (sxx - q) + (syy - q) * (syy - q) + (szz - q) * (szz - q) + 2.0 * p1;
  let p = sqrt(p2 / 6.0);
  let b11 = (sxx - q) / p; let b22 = (syy - q) / p; let b33 = (szz - q) / p;
  let b12 = sxy / p; let b23 = syz / p; let b13 = szx / p;
  let det = b11 * (b22 * b33 - b23 * b23) - b12 * (b12 * b33 - b23 * b13) + b13 * (b12 * b23 - b22 * b13);
  let r = clamp(det * 0.5, -1.0, 1.0);
  let phi = acos(r) / 3.0;
  let e1 = q + 2.0 * p * cos(phi);
  let e3 = q + 2.0 * p * cos(phi + 2.0943951);
  return vec3f(e1, 3.0 * q - e1 - e3, e3);
}

// field codes: 0 |U| · 1-3 U1..U3 · 4 Mises · 5-10 SXX SYY SZZ SXY SYZ SZX · 11 max principal · 12 min principal
//              13 CPRESS · 14 COPEN · 15 |CSLIP| · 16 Tresca
fn fieldF(f : u32, n : u32, code : i32) -> f32 {
  switch code {
    case 0: { return length(dispF(f, n)); }
    case 1, 2, 3: { return ch(f, n, u32(code - 1)); }
    case 5, 6, 7, 8, 9, 10: { return ch(f, n, u32(code - 2)); }
    case 13, 14, 15: { return ch(f, n, u32(code - 4)); }
    default: {
      let sxx = ch(f, n, 3u); let syy = ch(f, n, 4u); let szz = ch(f, n, 5u);
      let sxy = ch(f, n, 6u); let syz = ch(f, n, 7u); let szx = ch(f, n, 8u);
      if (code == 4) {
        return sqrt(max(0.0, 0.5 * ((sxx - syy) * (sxx - syy) + (syy - szz) * (syy - szz) + (szz - sxx) * (szz - sxx)) + 3.0 * (sxy * sxy + syz * syz + szx * szx)));
      }
      let e = principal(sxx, syy, szz, sxy, syz, szx);
      if (code == 11) { return e.x; }
      if (code == 12) { return e.z; }
      return e.x - e.z;
    }
  }
}
fn field(n : u32) -> f32 {
  let code = i32(u.fld.x);
  if (code < 0) { return 0.0; }
  return mix(fieldF(u32(u.fr.x), n, code), fieldF(u32(u.fr.y), n, code), u.fr.z);
}

fn toClip(p : vec3f) -> vec4f {
  var c = u.viewProj * vec4f(p, 1.0);
  c.z = 0.5 * (c.z + c.w);                        // three.js projection is GL style (-1..1); WebGPU wants 0..1
  return c;
}
fn viewDir(p : vec3f) -> vec3f {
  if (u.eye.w > 0.5) { return normalize(u.eye.xyz); }
  return normalize(u.eye.xyz - p);
}
fn cmap(v : f32) -> vec3f {
  var t = (v - u.fld.y) / max(u.fld.z - u.fld.y, 1e-30);
  t = clamp(t, 0.0, 1.0);
  if (u.fld.w > 0.5) { t = (floor(t * u.fld.w * 0.99999) + 0.5) / u.fld.w; }
  let x = t * 255.0; let i = u32(floor(x)); let fr = x - floor(x);
  return mix(LUT[i].rgb, LUT[min(i + 1u, 255u)].rgb, fr);
}
fn baseColor(v : f32, body : u32) -> vec3f {
  let bc = u.bodyCol[body];
  let code = i32(u.fld.x);
  if (u.opt.z > 0.5 || bc.w > 0.5 || code < 0) { return bc.rgb; }
  // contact quantities exist only on the contact faces: elsewhere (exactly 0) show the wood, slightly greyed
  if (code >= 13 && code <= 15 && abs(v) <= 1e-4 * max(abs(u.fld.y), abs(u.fld.z))) { return mix(bc.rgb, vec3f(0.80), 0.35); }
  return cmap(v);
}
fn shade(base : vec3f, n : vec3f, V : vec3f) -> vec3f {
  let L = normalize(V + 0.55 * u.light.xyz);
  let d = max(dot(n, L), 0.0);
  let h = normalize(L + V);
  let s = pow(max(dot(n, h), 0.0), 48.0) * 0.10;
  return base * (u.light.w + (1.0 - u.light.w) * d) + vec3f(s);
}
fn hidden() -> vec4f { return vec4f(2.0, 2.0, 2.0, 1.0); }   // outside the clip volume: the primitive is dropped
`;

export const SURFACE = /* wgsl */`
@group(1) @binding(0) var<storage, read> TRI : array<u32>;
@group(1) @binding(1) var<storage, read> TINFO : array<u32>;   // body | class << 8

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) wpos : vec3f,
  @location(1) nrm : vec3f,
  @location(2) val : f32,
  @location(3) @interpolate(flat) body : u32,
  @location(4) fpos : vec3f,
};

@vertex fn vs(@builtin(vertex_index) vi : u32) -> VOut {
  var o : VOut;
  let t = vi / 3u; let k = vi % 3u;
  let body = TINFO[t] & 255u;
  let off = u.bodyOff[body];
  if (off.w < 0.5) { o.pos = hidden(); return o; }
  let n0 = TRI[3u * t]; let n1 = TRI[3u * t + 1u]; let n2 = TRI[3u * t + 2u];
  let p0 = defPos(n0); let p1 = defPos(n1); let p2 = defPos(n2);
  var p = p0; var nn = n0;
  if (k == 1u) { p = p1; nn = n1; } else if (k == 2u) { p = p2; nn = n2; }
  o.wpos = p;
  o.fpos = p + off.xyz;
  o.pos = toClip(o.fpos);
  o.nrm = normalize(cross(p1 - p0, p2 - p0));
  o.val = field(nn);
  o.body = body;
  return o;
}

override ALPHA_MODE : u32 = 0u;     // 0 opaque, 1 the skin opacity
@fragment fn fs(i : VOut, @builtin(front_facing) ff : bool) -> @location(0) vec4f {
  if (u.opt.x > 0.5 && dot(i.wpos, u.clip.xyz) > u.clip.w) { discard; }
  var n = normalize(i.nrm); if (!ff) { n = -n; }
  var c = shade(baseColor(i.val, i.body), n, viewDir(i.fpos));
  var a = 1.0;
  if (ALPHA_MODE == 1u) { a = u.opt.y; }
  if (u.misc.z >= 0.0 && i32(u.misc.z) != i32(i.body)) { c = mix(c, vec3f(0.5), 0.55); }
  return vec4f(c, a);
}
@fragment fn fsPick(i : VOut) -> @location(0) vec4f {
  if (u.opt.x > 0.5 && dot(i.wpos, u.clip.xyz) > u.clip.w) { discard; }
  return vec4f(i.val, u.misc.y, f32(i.body), 1.0);
}
`;

export const SECTION_DRAW = /* wgsl */`
@group(1) @binding(0) var<storage, read> SEC : array<vec4u>;   // node a, node b, t (bits), body

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) val : f32,
  @location(1) @interpolate(flat) body : u32,
  @location(2) fpos : vec3f,
};
@vertex fn vs(@builtin(vertex_index) vi : u32) -> VOut {
  var o : VOut;
  let s = SEC[vi];
  let t = bitcast<f32>(s.z);
  let p = mix(defPos(s.x), defPos(s.y), t);
  o.fpos = p + u.bodyOff[s.w].xyz;
  o.pos = toClip(o.fpos);
  o.val = mix(field(s.x), field(s.y), t);
  o.body = s.w;
  return o;
}
@fragment fn fs(i : VOut) -> @location(0) vec4f {
  let V = viewDir(i.fpos);
  var n = normalize(u.clip.xyz); if (dot(n, V) < 0.0) { n = -n; }
  var c = shade(baseColor(i.val, i.body), n, V) * u.misc.x;
  if (u.misc.z >= 0.0 && i32(u.misc.z) != i32(i.body)) { c = mix(c, vec3f(0.5), 0.55); }
  return vec4f(c, 1.0);
}
@fragment fn fsPick(i : VOut) -> @location(0) vec4f { return vec4f(i.val, u.misc.y, f32(i.body), 1.0); }
`;

export const SECTION_COMPUTE = /* wgsl */`
@group(1) @binding(0) var<storage, read> TET : array<u32>;            // a b c d | body << 24 in d
@group(1) @binding(1) var<storage, read_write> SEC : array<vec4u>;
@group(1) @binding(2) var<storage, read_write> CNT : array<atomic<u32>>;
@group(1) @binding(3) var<storage, read_write> IND : array<u32>;      // drawIndirect args

fn emit(a : vec4u, b : vec4u, c : vec4u) {
  let cap = arrayLength(&SEC) / 3u;
  let k = atomicAdd(&CNT[0], 1u);
  if (k >= cap) { return; }
  SEC[3u * k] = a; SEC[3u * k + 1u] = b; SEC[3u * k + 2u] = c;
}
fn cut(i : u32, j : u32, di : f32, dj : f32, body : u32) -> vec4u {
  return vec4u(i, j, bitcast<u32>(di / (di - dj)), body);
}

@compute @workgroup_size(64) fn section(@builtin(global_invocation_id) g : vec3u) {
  let t = g.x;
  if (t >= arrayLength(&TET) / 4u) { return; }
  let w3 = TET[4u * t + 3u];
  let body = w3 >> 24u;
  if (u.bodyOff[body].w < 0.5) { return; }
  var id = array<u32, 4>(TET[4u * t], TET[4u * t + 1u], TET[4u * t + 2u], w3 & 0xFFFFFFu);
  var d : array<f32, 4>;
  var neg = 0u; var mask = 0u;
  for (var k = 0u; k < 4u; k++) {
    d[k] = dot(defPos(id[k]), u.clip.xyz) - u.clip.w;
    if (d[k] <= 0.0) { neg++; mask |= (1u << k); }
  }
  if (neg == 0u || neg == 4u) { return; }
  if (neg == 1u || neg == 3u) {
    // the lone vertex on its side and the three others
    var lone = 0u;
    for (var k = 0u; k < 4u; k++) { let inside = (mask >> k) & 1u; if ((neg == 1u && inside == 1u) || (neg == 3u && inside == 0u)) { lone = k; } }
    var o = array<u32, 3>(0u, 0u, 0u); var m = 0u;
    for (var k = 0u; k < 4u; k++) { if (k != lone) { o[m] = k; m++; } }
    emit(cut(id[lone], id[o[0]], d[lone], d[o[0]], body), cut(id[lone], id[o[1]], d[lone], d[o[1]], body), cut(id[lone], id[o[2]], d[lone], d[o[2]], body));
    return;
  }
  // two and two: quad (i,k) (i,l) (j,l) (j,k)
  var a = array<u32, 2>(0u, 0u); var b = array<u32, 2>(0u, 0u); var na = 0u; var nb = 0u;
  for (var k = 0u; k < 4u; k++) { if (((mask >> k) & 1u) == 1u) { a[na] = k; na++; } else { b[nb] = k; nb++; } }
  let q0 = cut(id[a[0]], id[b[0]], d[a[0]], d[b[0]], body);
  let q1 = cut(id[a[0]], id[b[1]], d[a[0]], d[b[1]], body);
  let q2 = cut(id[a[1]], id[b[1]], d[a[1]], d[b[1]], body);
  let q3 = cut(id[a[1]], id[b[0]], d[a[1]], d[b[0]], body);
  emit(q0, q1, q2); emit(q0, q2, q3);
}

@compute @workgroup_size(1) fn args() {
  let cap = arrayLength(&SEC) / 3u;
  IND[0] = min(atomicLoad(&CNT[0]), cap) * 3u; IND[1] = 1u; IND[2] = 0u; IND[3] = 0u;
}
`;

export const EDGES = /* wgsl */`
@group(1) @binding(0) var<storage, read> EDG : array<u32>;    // node | body << 24, two per edge

struct VOut { @builtin(position) pos : vec4f, @location(0) wpos : vec3f };
@vertex fn vs(@builtin(vertex_index) vi : u32) -> VOut {
  var o : VOut;
  let w = EDG[vi]; let body = EDG[vi & ~1u] >> 24u;
  let off = u.bodyOff[body];
  if (off.w < 0.5) { o.pos = hidden(); return o; }
  let p = defPos(w & 0xFFFFFFu);
  o.wpos = p;
  var c = toClip(p + off.xyz);
  c.z = c.z - u.misc.w * c.w;
  o.pos = c;
  return o;
}
@fragment fn fs(i : VOut) -> @location(0) vec4f {
  if (u.opt.x > 0.5 && dot(i.wpos, u.clip.xyz) > u.clip.w + 1e-3) { discard; }
  return u.edgeCol;
}
`;

export const RIG = /* wgsl */`
struct VIn { @location(0) pos : vec3f, @location(1) nrm : vec3f, @location(2) col : vec4f, @location(3) anchor : u32 };
struct VOut { @builtin(position) pos : vec4f, @location(0) nrm : vec3f, @location(1) col : vec4f, @location(2) fpos : vec3f, @location(3) apos : vec3f };
@vertex fn vs(v : VIn) -> VOut {
  var o : VOut;
  var p = v.pos;
  var a = v.pos;
  if (v.anchor != 0xFFFFFFFFu) { p = p + u.fr.w * disp(v.anchor); a = defPos(v.anchor); }
  o.fpos = p; o.apos = a; o.pos = toClip(p); o.nrm = v.nrm; o.col = v.col;
  return o;
}
@fragment fn fs(i : VOut, @builtin(front_facing) ff : bool) -> @location(0) vec4f {
  // a rig part goes with the side of the section its anchor (or itself) is on
  if (u.opt.x > 0.5 && dot(i.apos, u.clip.xyz) > u.clip.w) { discard; }
  var n = normalize(i.nrm); if (!ff) { n = -n; }
  return vec4f(shade(i.col.rgb, n, viewDir(i.fpos)), i.col.a);
}
`;
