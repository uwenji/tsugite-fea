// One camera shared by every viewport (the four joints turn together). three.js is used only for the camera maths,
// OrbitControls and the view cube; the drawing is WebGPU (gpu.js). Z is up, the bar runs along Y.
// Camera moves (view cube, home, fit, roll, turntable, projection) follow LocalSH's view.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { NavCube } from './navcube.js';

const Z_UP = new THREE.Vector3(0, 0, 1);
const POLE_EPS = 2e-3;
export const HOME_DIRS = {                         // per load type: look where the joint deforms
  default: [0.95, -0.30, 0.40], bending: [1, -0.20, 0.28], shear_z: [1, -0.20, 0.28],
  bending_edge: [0.40, -0.07, 1], shear_x: [0.40, -0.07, 1], torsion: [0.92, -0.36, 0.50],
};

export class CameraRig {
  constructor(canvas) {
    this.canvas = canvas;
    this.persp = new THREE.PerspectiveCamera(30, 1, 1, 10000); this.persp.up.set(0, 0, 1);
    this.orthoH = 100;
    this.ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 10000); this.ortho.up.set(0, 0, 1);
    this.camera = this.persp; this.projection = 'persp';
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12; this.controls.rotateSpeed = 0.7; this.controls.zoomSpeed = 0.9;
    this.controls.screenSpacePanning = true;
    this.clock = new THREE.Clock(); this.anim = null; this.turntable = false; this.turnSpeed = 8;
    this.box = { lo: [-28, -200, -12.5], hi: [28, 200, 12.5] }; this.aspect = 1;
    canvas.addEventListener('pointerdown', () => { this.anim = null; this.dragging = true; this.onUser?.(); });
    addEventListener('pointerup', () => { this.dragging = false; });
    canvas.addEventListener('wheel', () => { this.anim = null; this.onUser?.(); }, { passive: true });
    this.camera.position.set(400, -200, 250); this.controls.target.set(0, 0, 0); this.controls.update();
  }

  attachNav(canvas) {
    this.nav = new NavCube(canvas, {
      onPick: (dir) => { this.onUser?.(); this.lookFrom(dir); },
      onDrag: (dx, dy) => { this.onUser?.(); const h = this.canvas.clientHeight || 600, k = 2 * Math.PI * this.controls.rotateSpeed / h; this.controls._rotateLeft(k * dx); this.controls._rotateUp(k * dy); },
    });
  }

  /** the aspect used for fitting (the viewports' w/h) */
  setAspect(a) { this.aspect = a || 1; }
  setBox(lo, hi) { this.box = { lo, hi }; const d = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]); for (const c of [this.persp, this.ortho]) { c.near = d * 0.01; c.far = d * 30; } }

  /** exhibition sway: the view swings ±amp° about the vertical around dir, period in s (a turntable would show the bar end-on) */
  setSway(dir, amp = 22, period = 24) { this.sway = dir ? { dir: new THREE.Vector3(...dir).normalize(), amp: THREE.MathUtils.degToRad(amp), period, t0: performance.now() } : null; }

  update() {
    const dt = Math.min(this.clock.getDelta(), 0.5);
    if (this.sway && !this.anim && !this.dragging) {
      const s = this.sway, ph = Math.sin(2 * Math.PI * (performance.now() - s.t0) / 1000 / s.period) * s.amp;
      const d = s.dir.clone().applyAxisAngle(Z_UP, ph), f = this.fitFor(d);
      this.controls.target.copy(f.target);
      if (this.projection === 'ortho') { this.ortho.zoom = f.zoom; this.ortho.updateProjectionMatrix(); this.camera.position.copy(f.target).addScaledVector(d, f.dist); }
      else this.camera.position.copy(f.target).addScaledVector(d, f.dist);
      this.camera.lookAt(f.target);
    }
    this._stepAnim();
    this.controls.update(dt);
    this.camera.updateMatrixWorld();
    if (this.nav) this.nav.render(this.camera, this.controls.target);
  }

  /** view-projection (column-major Float32Array 16) for a viewport of the given aspect; optional pick window */
  viewProj(aspect, pick) {
    const c = this.camera;
    if (c.isPerspectiveCamera) { c.aspect = aspect; c.updateProjectionMatrix(); }
    else { c.left = -this.orthoH * aspect; c.right = this.orthoH * aspect; c.top = this.orthoH; c.bottom = -this.orthoH; c.updateProjectionMatrix(); }
    const m = new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    if (pick) {                       // pick = {x, y, w, h} in viewport pixels (y down): map that pixel to the whole NDC square
      const sx = pick.w, sy = pick.h, cx = (2 * (pick.x + 0.5) / pick.w - 1), cy = 1 - 2 * (pick.y + 0.5) / pick.h;
      const P = new THREE.Matrix4().set(sx, 0, 0, -cx * sx, 0, sy, 0, -cy * sy, 0, 0, 1, 0, 0, 0, 0, 1);
      m.premultiply(P);
    }
    return m.elements;
  }
  eye() {
    const c = this.camera;
    if (c.isOrthographicCamera) { const d = this.viewDir(); return [d.x, d.y, d.z, 1]; }
    return [c.position.x, c.position.y, c.position.z, 0];
  }
  up() { const u = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion); return [u.x, u.y, u.z]; }

  viewDir() { const d = this.camera.position.clone().sub(this.controls.target); return d.lengthSq() > 1e-18 ? d.normalize() : new THREE.Vector3(...HOME_DIRS.default).normalize(); }
  viewDist() { return this.camera.position.distanceTo(this.controls.target); }

  /** distance (persp) and zoom (ortho) that frame box {lo, hi} from direction dir in a viewport of aspect a */
  fitFor(dir, box = this.box, a = this.aspect, margin = 1.06) {
    const d = dir.clone().normalize();
    let up = Z_UP.clone().sub(d.clone().multiplyScalar(d.dot(Z_UP)));
    if (up.lengthSq() < 1e-8) up = new THREE.Vector3(0, 1, 0).sub(d.clone().multiplyScalar(d.y));
    up.normalize();
    const right = new THREE.Vector3().crossVectors(up, d).normalize();
    const c = new THREE.Vector3((box.lo[0] + box.hi[0]) / 2, (box.lo[1] + box.hi[1]) / 2, (box.lo[2] + box.hi[2]) / 2);
    let hw = 0, hh = 0, hd = 0;
    for (const x of [box.lo[0], box.hi[0]]) for (const y of [box.lo[1], box.hi[1]]) for (const z of [box.lo[2], box.hi[2]]) {
      const p = new THREE.Vector3(x, y, z).sub(c);
      hw = Math.max(hw, Math.abs(p.dot(right))); hh = Math.max(hh, Math.abs(p.dot(up))); hd = Math.max(hd, Math.abs(p.dot(d)));
    }
    hw *= margin; hh *= margin;
    const tan = Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    const half = Math.max(hh, hw / a);
    return { target: c, dist: half / tan + hd, zoom: this.orthoH / half };
  }

  lookFrom(dir, opts = {}) {
    const d = (dir.isVector3 ? dir.clone() : new THREE.Vector3().fromArray(dir)).normalize();
    if (1 - Math.abs(d.z) < 1e-6) {
      const t = opts.tiltFrom && Math.hypot(opts.tiltFrom.x, opts.tiltFrom.y) > 1e-9 ? new THREE.Vector3(opts.tiltFrom.x, opts.tiltFrom.y, 0).normalize() : new THREE.Vector3(0, -1, 0);
      d.set(t.x * POLE_EPS, t.y * POLE_EPS, Math.sign(d.z)).normalize();
    }
    const fit = opts.refit !== false;
    this.anim = {
      t0: performance.now(), ms: opts.ms ?? 450, dir0: this.viewDir(), dir1: d, dist0: this.viewDist(), dist1: opts.dist ?? this.viewDist(),
      tg0: this.controls.target.clone(), tg1: opts.target ? opts.target.clone() : this.controls.target.clone(),
      zoom0: this.ortho.zoom, zoom1: opts.zoom ?? this.ortho.zoom, fitBox: fit ? (opts.box || null) : undefined,
    };
    if (opts.ms === 0) this._stepAnim(performance.now() + 1);
  }

  _stepAnim(now = performance.now()) {
    const a = this.anim; if (!a) return;
    if (a.fitBox !== undefined) {                 // the end of the move is fitted to the current viewport shape
      const f = this.fitFor(a.dir1, a.fitBox || this.box);
      a.dist1 = f.dist; a.tg1 = f.target; a.zoom1 = f.zoom;
    }
    const t = Math.min(1, (now - a.t0) / Math.max(a.ms, 1)), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const dir = slerp(a.dir0, a.dir1, e), dist = a.dist0 + (a.dist1 - a.dist0) * e;
    this.controls.target.copy(a.tg0).lerp(a.tg1, e);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    if (this.projection === 'ortho') { this.ortho.zoom = a.zoom0 + (a.zoom1 - a.zoom0) * e; this.ortho.updateProjectionMatrix(); }
    this.camera.lookAt(this.controls.target);
    if (t >= 1) this.anim = null;
  }

  orbitBy(dAz, dPol) {
    const d0 = this.viewDir(), az = Math.atan2(d0.y, d0.x) + dAz;
    const pol = Math.min(Math.PI - POLE_EPS, Math.max(POLE_EPS, Math.acos(Math.max(-1, Math.min(1, d0.z))) + dPol));
    this.lookFrom(new THREE.Vector3(Math.sin(pol) * Math.cos(az), Math.sin(pol) * Math.sin(az), Math.cos(pol)), { tiltFrom: d0, refit: false });
  }
  home(type, ms = 500) { this.lookFrom(HOME_DIRS[type] || HOME_DIRS.default, { ms }); }
  fit(box, ms = 400) { this.lookFrom(this.viewDir(), { ms, tiltFrom: this.viewDir(), box }); }

  setTurntable(on, degPerSec = this.turnSpeed) {
    this.turntable = !!on; this.turnSpeed = degPerSec;
    this.controls.autoRotate = this.turntable; this.controls.autoRotateSpeed = degPerSec / 6;
  }

  setProjection(kind) {
    if (kind === this.projection) return;
    const dir = this.viewDir(), tg = this.controls.target.clone(), tanHalf = Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    this.anim = null;
    if (kind === 'ortho') {
      const hh = this.viewDist() * tanHalf;
      this.ortho.zoom = this.orthoH / hh; this.ortho.position.copy(this.persp.position); this.ortho.updateProjectionMatrix();
      this.camera = this.ortho;
    } else {
      const hh = this.orthoH / this.ortho.zoom;
      this.persp.position.copy(tg).addScaledVector(dir, hh / tanHalf);
      this.camera = this.persp;
    }
    this.projection = kind; this.controls.object = this.camera; this.camera.lookAt(tg); this.controls.update();
  }
}

function slerp(a, b, t) {
  const dot = Math.max(-1, Math.min(1, a.dot(b))), om = Math.acos(dot);
  if (om < 1e-6) return b.clone();
  if (om > Math.PI - 1e-3) {
    let m = new THREE.Vector3().crossVectors(a, Math.abs(a.z) < 0.9 ? Z_UP : new THREE.Vector3(0, 1, 0)).normalize();
    m = new THREE.Vector3().crossVectors(m, a).normalize();
    return t < 0.5 ? slerp(a, m, 2 * t) : slerp(m, b, 2 * t - 1);
  }
  const s = Math.sin(om);
  return a.clone().multiplyScalar(Math.sin((1 - t) * om) / s).addScaledVector(b, Math.sin(t * om) / s).normalize();
}
