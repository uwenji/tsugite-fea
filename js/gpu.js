// WebGPU renderer for the joint results: several viewports on one canvas (one per joint in the comparison), each
// drawing a mesh + case with its own uniforms. Per viewport and frame:
//   compute  section: every tet is cut by the plane on the GPU (deformed state) -> triangles + drawIndirect args
//   render   tools, joint faces, opaque skin, section caps, rig, edges, then the transparent skin (back faces, front faces)
// Picking renders the same surfaces into a 1×1 float target under a pick matrix and reads the value back.
import { COMMON, SURFACE, SECTION_DRAW, SECTION_COMPUTE, EDGES, RIG } from './shaders.js';

const UNIFORM_BYTES = 512;          // two slots per viewport: [0] drawing, [256..] unused, [512] picking
const SLOT = 512;
const SEC_CAP = 131072;             // section triangles per viewport
const MSAA = 4;
const DEPTH = 'depth24plus';

export class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('navigator.gpu is missing (WebGPU is off or the page is not a secure context)');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter');
    const lim = adapter.limits;
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: Math.min(lim.maxStorageBufferBindingSize, 1 << 30), maxBufferSize: Math.min(lim.maxBufferSize, 1 << 30) },
    });
    return new Renderer(canvas, device, adapter);
  }

  constructor(canvas, device, adapter) {
    this.canvas = canvas; this.device = device; this.adapter = adapter;
    this.info = adapter.info || {};
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.lost = false;
    device.lost.then((e) => { this.lost = true; console.error('WebGPU device lost', e); this.onLost?.(e); });
    device.addEventListener?.('uncapturederror', (e) => console.error('WebGPU:', e.error?.message || e));
    this.meshes = new Map(); this.cases = new Map(); this.vps = [];
    this.clear = [0.96, 0.96, 0.96, 1];
    this._layouts(); this._pipelines();
    this.lut = device.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.pickTex = device.createTexture({ size: [1, 1], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.pickDepth = device.createTexture({ size: [1, 1], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.pickBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.picking = false;
  }

  // ------------------------------------------------------------------------------------------------- layouts, pipelines
  _layouts() {
    const d = this.device, V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT, C = GPUShaderStage.COMPUTE;
    const ro = (binding, visibility) => ({ binding, visibility, buffer: { type: 'read-only-storage' } });
    const rw = (binding) => ({ binding, visibility: C, buffer: { type: 'storage' } });
    this.bgl0 = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: V | F | C, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 448 } },
      ro(1, V | C), ro(2, V | C), ro(3, V | C), ro(4, F),
    ] });
    this.bglSurf = d.createBindGroupLayout({ entries: [ro(0, V), ro(1, V)] });
    this.bglEdge = d.createBindGroupLayout({ entries: [ro(0, V)] });
    this.bglSecDraw = d.createBindGroupLayout({ entries: [ro(0, V)] });
    this.bglSecComp = d.createBindGroupLayout({ entries: [ro(0, C), rw(1), rw(2), rw(3)] });
  }

  _pipelines() {
    const d = this.device;
    const mod = (code, label) => d.createShaderModule({ code: COMMON + code, label });
    const mSurf = mod(SURFACE, 'surface'), mSec = mod(SECTION_DRAW, 'section draw'), mComp = mod(SECTION_COMPUTE, 'section compute');
    const mEdge = mod(EDGES, 'edges'), mRig = mod(RIG, 'rig');
    const layout = (g1) => d.createPipelineLayout({ bindGroupLayouts: g1 ? [this.bgl0, g1] : [this.bgl0] });
    const blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
    const ds = (write, bias = 0) => ({ format: DEPTH, depthWriteEnabled: write, depthCompare: 'less-equal', depthBias: bias, depthBiasSlopeScale: bias ? 1.5 : 0 });
    const tgt = (b) => [{ format: this.format, blend: b }];
    const tri = (cull) => ({ topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' });
    const ms = { count: MSAA };
    this.pSurf = d.createRenderPipeline({ label: 'surface opaque', layout: layout(this.bglSurf), vertex: { module: mSurf, entryPoint: 'vs' },
      fragment: { module: mSurf, entryPoint: 'fs', targets: tgt(), constants: { ALPHA_MODE: 0 } }, primitive: tri('back'), depthStencil: ds(true, 2), multisample: ms });
    this.pSurf2 = d.createRenderPipeline({ label: 'surface opaque two-sided', layout: layout(this.bglSurf), vertex: { module: mSurf, entryPoint: 'vs' },
      fragment: { module: mSurf, entryPoint: 'fs', targets: tgt(), constants: { ALPHA_MODE: 0 } }, primitive: tri('none'), depthStencil: ds(true, 2), multisample: ms });
    this.pSkinBack = d.createRenderPipeline({ label: 'skin back', layout: layout(this.bglSurf), vertex: { module: mSurf, entryPoint: 'vs' },
      fragment: { module: mSurf, entryPoint: 'fs', targets: tgt(blend), constants: { ALPHA_MODE: 1 } }, primitive: tri('front'), depthStencil: ds(false, 2), multisample: ms });
    this.pSkinFront = d.createRenderPipeline({ label: 'skin front', layout: layout(this.bglSurf), vertex: { module: mSurf, entryPoint: 'vs' },
      fragment: { module: mSurf, entryPoint: 'fs', targets: tgt(blend), constants: { ALPHA_MODE: 1 } }, primitive: tri('back'), depthStencil: ds(false, 2), multisample: ms });
    this.pSec = d.createRenderPipeline({ label: 'section caps', layout: layout(this.bglSecDraw), vertex: { module: mSec, entryPoint: 'vs' },
      fragment: { module: mSec, entryPoint: 'fs', targets: tgt() }, primitive: tri('none'), depthStencil: ds(true, 1), multisample: ms });
    this.pEdge = d.createRenderPipeline({ label: 'edges', layout: layout(this.bglEdge), vertex: { module: mEdge, entryPoint: 'vs' },
      fragment: { module: mEdge, entryPoint: 'fs', targets: tgt(blend) }, primitive: { topology: 'line-list' }, depthStencil: ds(true, 0), multisample: ms });
    this.pRig = d.createRenderPipeline({ label: 'rig', layout: layout(null),
      vertex: { module: mRig, entryPoint: 'vs', buffers: [{ arrayStride: 32, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'unorm8x4' }, { shaderLocation: 3, offset: 28, format: 'uint32' }] }] },
      fragment: { module: mRig, entryPoint: 'fs', targets: tgt(blend) }, primitive: tri('none'), depthStencil: ds(false, 0), multisample: ms });
    this.pCompSec = d.createComputePipeline({ label: 'section', layout: layout(this.bglSecComp), compute: { module: mComp, entryPoint: 'section' } });
    this.pCompArgs = d.createComputePipeline({ label: 'section args', layout: layout(this.bglSecComp), compute: { module: mComp, entryPoint: 'args' } });
    const pickT = [{ format: 'rgba32float' }], pds = { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less-equal' };
    this.pPickSurf = d.createRenderPipeline({ label: 'pick surface', layout: layout(this.bglSurf), vertex: { module: mSurf, entryPoint: 'vs' },
      fragment: { module: mSurf, entryPoint: 'fsPick', targets: pickT }, primitive: tri('back'), depthStencil: pds });
    this.pPickSec = d.createRenderPipeline({ label: 'pick section', layout: layout(this.bglSecDraw), vertex: { module: mSec, entryPoint: 'vs' },
      fragment: { module: mSec, entryPoint: 'fsPick', targets: pickT }, primitive: tri('none'), depthStencil: pds });
  }

  // ------------------------------------------------------------------------------------------------------ resources
  _buf(data, usage, label) {
    const size = Math.max(16, Math.ceil(data.byteLength / 4) * 4);
    const b = this.device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST, label, mappedAtCreation: true });
    new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    b.unmap();
    return b;
  }

  /** mesh (from data.js) -> GPU buffers, cached by name */
  meshGPU(m) {
    if (this.meshes.has(m.name)) return this.meshes.get(m.name);
    const S = GPUBufferUsage.STORAGE;
    const tets = new Uint32Array(m.tets);                         // pack the body into the top byte of the 4th node
    for (let i = 0; i < m.nTets; i++) tets[4 * i + 3] = (tets[4 * i + 3] & 0xFFFFFF) | (m.tetBody[i] << 24);
    const tinfo = new Uint32Array(m.nTris);
    for (let i = 0; i < m.nTris; i++) tinfo[i] = m.triBody[i] | (m.triClass[i] << 8);
    const edg = new Uint32Array(m.edges);
    for (let i = 0; i < m.nEdges; i++) edg[2 * i] = (edg[2 * i] & 0xFFFFFF) | (m.edgeBody[i] << 24);
    const g = {
      name: m.name, nTris: m.nTris, nEdges: m.nEdges, nTets: m.nTets, triRanges: m.triRanges,
      P: this._buf(m.P, S, 'P'), TRI: this._buf(m.tri, S, 'tri'), TINFO: this._buf(tinfo, S, 'tinfo'),
      EDG: this._buf(edg.length ? edg : new Uint32Array(4), S, 'edges'), TET: this._buf(tets, S, 'tets'),
    };
    g.bgSurf = this.device.createBindGroup({ layout: this.bglSurf, entries: [{ binding: 0, resource: { buffer: g.TRI } }, { binding: 1, resource: { buffer: g.TINFO } }] });
    g.bgEdge = this.device.createBindGroup({ layout: this.bglEdge, entries: [{ binding: 0, resource: { buffer: g.EDG } }] });
    this.meshes.set(m.name, g);
    return g;
  }

  caseGPU(c) {
    if (this.cases.has(c.name)) return this.cases.get(c.name);
    const S = GPUBufferUsage.STORAGE;
    const g = { name: c.name, FR: this._buf(c.frames, S, 'frames ' + c.name), RG: this._buf(c.ranges, S, 'ranges ' + c.name), bytes: c.frames.byteLength };
    this.cases.set(c.name, g);
    return g;
  }

  /** drop GPU copies of cases not in keep (names) once more than `max` are resident */
  trim(keep, max = 14) {
    if (this.cases.size <= max) return;
    for (const [k, g] of this.cases) {
      if (this.cases.size <= max) break;
      if (keep.has(k)) continue;
      g.FR.destroy(); g.RG.destroy(); this.cases.delete(k);
      for (const v of this.vps) if (v.caseName === k) v.bg0 = null;
    }
  }

  setLUT(lut /* Float32Array 256*4 */) { this.device.queue.writeBuffer(this.lut, 0, lut); }

  /** per viewport state: uniforms, section buffers, bind groups (rebuilt when its mesh/case changes) */
  _vp(i) {
    while (this.vps.length <= i) {
      const d = this.device;
      const v = {
        ub: d.createBuffer({ size: 2 * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        sec: d.createBuffer({ size: SEC_CAP * 3 * 16, usage: GPUBufferUsage.STORAGE }),
        cnt: d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
        ind: d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST }),
        rig: null, rigCount: 0, rigKey: null,
      };
      v.bgSecDraw = d.createBindGroup({ layout: this.bglSecDraw, entries: [{ binding: 0, resource: { buffer: v.sec } }] });
      this.vps.push(v);
    }
    return this.vps[i];
  }

  _bindViewport(v, mg, cg) {
    if (v.bg0 && v.meshName === mg.name && v.caseName === cg.name) return;
    const d = this.device;
    v.bg0 = d.createBindGroup({ layout: this.bgl0, entries: [
      { binding: 0, resource: { buffer: v.ub, offset: 0, size: 448 } }, { binding: 1, resource: { buffer: mg.P } },
      { binding: 2, resource: { buffer: cg.FR } }, { binding: 3, resource: { buffer: cg.RG } }, { binding: 4, resource: { buffer: this.lut } }] });
    v.bgComp = d.createBindGroup({ layout: this.bglSecComp, entries: [
      { binding: 0, resource: { buffer: mg.TET } }, { binding: 1, resource: { buffer: v.sec } },
      { binding: 2, resource: { buffer: v.cnt } }, { binding: 3, resource: { buffer: v.ind } }] });
    v.meshName = mg.name; v.caseName = cg.name;
  }

  setRig(i, key, data /* {buf: ArrayBuffer, count} */) {
    const v = this._vp(i);
    if (v.rigKey === key) return;
    v.rig?.destroy(); v.rig = null; v.rigCount = 0; v.rigKey = key;
    if (data && data.count) { v.rig = this._buf(new Uint8Array(data.buf), GPUBufferUsage.VERTEX, 'rig'); v.rigCount = data.count; }
  }

  // --------------------------------------------------------------------------------------------------------- frame
  _targets() {
    const w = this.canvas.width, h = this.canvas.height;
    if (this.msaa && this.msaa.width === w && this.msaa.height === h) return;
    this.msaa?.destroy(); this.depth?.destroy();
    this.msaa = this.device.createTexture({ size: [w, h], format: this.format, sampleCount: MSAA, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depth = this.device.createTexture({ size: [w, h], format: DEPTH, sampleCount: MSAA, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  /** uniform block (Float32Array of 112) for one viewport; p from app: see app.js uniformsFor() */
  _writeUniform(v, f32, slot = 0) { this.device.queue.writeBuffer(v.ub, slot * SLOT, f32); }

  /**
   * views: [{ rect:[x,y,w,h] (device px), mesh, case, meshGPU, caseGPU, uniform: Float32Array(112),
   *           skinAlpha, inner, edges, section, rig, tools }]
   */
  render(views) {
    if (this.lost) return;
    const d = this.device;
    this._targets();
    const enc = d.createCommandEncoder();
    // section cut per viewport (compute)
    const active = [];
    views.forEach((w, i) => {
      if (!w.meshGPU || !w.caseGPU) return;
      const v = this._vp(i);
      this._bindViewport(v, w.meshGPU, w.caseGPU);
      this._writeUniform(v, w.uniform);
      active.push([w, v]);
      if (w.section) {
        enc.clearBuffer(v.cnt);
        const cp = enc.beginComputePass();
        cp.setPipeline(this.pCompSec); cp.setBindGroup(0, v.bg0, [0]); cp.setBindGroup(1, v.bgComp);
        cp.dispatchWorkgroups(Math.ceil(w.meshGPU.nTets / 64));
        cp.setPipeline(this.pCompArgs); cp.dispatchWorkgroups(1);
        cp.end();
      }
    });
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaa.createView(), resolveTarget: this.ctx.getCurrentTexture().createView(), clearValue: { r: this.clear[0], g: this.clear[1], b: this.clear[2], a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    const W = this.canvas.width, H = this.canvas.height;
    for (const [w, v] of active) {
      let [x, y, rw, rh] = w.rect.map(Math.round);
      x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y)); rw = Math.max(1, Math.min(W - x, rw)); rh = Math.max(1, Math.min(H - y, rh));
      pass.setViewport(x, y, rw, rh, 0, 1); pass.setScissorRect(x, y, rw, rh);
      const mg = w.meshGPU, [r0, r1, r2] = mg.triRanges;
      const draw = (pipe, range) => { if (range[1] > 0) { pass.setPipeline(pipe); pass.setBindGroup(0, v.bg0, [0]); pass.setBindGroup(1, mg.bgSurf); pass.draw(range[1] * 3, 1, range[0] * 3); } };
      if (w.tools) draw(this.pSurf, r2);
      if (w.inner) draw(this.pSurf, r1);
      if (w.skinAlpha >= 0.995) draw(this.pSurf, r0);
      if (w.section) { pass.setPipeline(this.pSec); pass.setBindGroup(0, v.bg0, [0]); pass.setBindGroup(1, v.bgSecDraw); pass.drawIndirect(v.ind, 0); }
      if (w.edges && mg.nEdges) { pass.setPipeline(this.pEdge); pass.setBindGroup(0, v.bg0, [0]); pass.setBindGroup(1, mg.bgEdge); pass.draw(mg.nEdges * 2); }
      if (w.rig && v.rig) { pass.setPipeline(this.pRig); pass.setBindGroup(0, v.bg0, [0]); pass.setVertexBuffer(0, v.rig); pass.draw(v.rigCount); }
      if (w.skinAlpha > 0.004 && w.skinAlpha < 0.995) { draw(this.pSkinBack, r0); draw(this.pSkinFront, r0); }
    }
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  /** value under device pixel (px, py) in viewport i: Promise<{val, vp, body} | null> */
  async pick(views, i, px, py) {
    if (this.picking || this.lost) return null;
    const w = views[i]; if (!w || !w.meshGPU || !w.caseGPU) return null;
    const v = this._vp(i);
    this._bindViewport(v, w.meshGPU, w.caseGPU);
    this._writeUniform(v, w.pickUniform, 1);
    this.picking = true;
    try {
      const d = this.device, enc = d.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.pickTex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: this.pickDepth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      const mg = w.meshGPU, [r0, r1, r2] = mg.triRanges;
      const draw = (range) => { if (range[1] > 0) { pass.setPipeline(this.pPickSurf); pass.setBindGroup(0, v.bg0, [SLOT]); pass.setBindGroup(1, mg.bgSurf); pass.draw(range[1] * 3, 1, range[0] * 3); } };
      if (w.inner) draw(r1);
      if (w.skinAlpha >= 0.5) draw(r0);
      if (w.section) { pass.setPipeline(this.pPickSec); pass.setBindGroup(0, v.bg0, [SLOT]); pass.setBindGroup(1, v.bgSecDraw); pass.drawIndirect(v.ind, 0); }
      pass.end();
      enc.copyTextureToBuffer({ texture: this.pickTex }, { buffer: this.pickBuf, bytesPerRow: 256 }, [1, 1]);
      d.queue.submit([enc.finish()]);
      await this.pickBuf.mapAsync(GPUMapMode.READ);
      const a = new Float32Array(this.pickBuf.getMappedRange().slice(0, 16));
      this.pickBuf.unmap();
      return a[3] > 0.5 ? { val: a[0], vp: a[1], body: a[2] } : null;
    } finally { this.picking = false; }
  }
}
