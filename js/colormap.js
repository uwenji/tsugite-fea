// Colour maps as 256-entry LUTs (RGBA float, for the GPU) and a painter for the legend bar.
const VIRIDIS = [[0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.530], [0.207, 0.372, 0.553], [0.164, 0.471, 0.558], [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441], [0.478, 0.821, 0.318], [0.741, 0.873, 0.150], [0.993, 0.906, 0.144]];
const COOLWARM = [[0.230, 0.299, 0.754], [0.406, 0.538, 0.934], [0.602, 0.731, 0.999], [0.790, 0.845, 0.939], [0.867, 0.867, 0.867], [0.941, 0.790, 0.700], [0.958, 0.603, 0.482], [0.867, 0.389, 0.282], [0.706, 0.016, 0.150]];
const INFERNO = [[0.001, 0.000, 0.014], [0.087, 0.045, 0.225], [0.258, 0.039, 0.406], [0.416, 0.090, 0.433], [0.578, 0.148, 0.404], [0.735, 0.216, 0.330], [0.865, 0.317, 0.226], [0.954, 0.469, 0.106], [0.988, 0.645, 0.040], [0.964, 0.843, 0.273], [0.988, 0.998, 0.645]];

function fromAnchors(a) {
  const lut = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (a.length - 1), k = Math.min(Math.floor(t), a.length - 2), f = t - k;
    for (let c = 0; c < 3; c++) lut[4 * i + c] = a[k][c] * (1 - f) + a[k + 1][c] * f;
    lut[4 * i + 3] = 1;
  }
  return lut;
}
function turbo() {          // Google's Turbo, polynomial fit (Mikhailov 2019): the familiar FEA rainbow without its dark bands
  const lut = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const r = 0.13572138 + t * (4.61539260 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
    const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
    const b = 0.10667330 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
    lut[4 * i] = Math.min(1, Math.max(0, r)); lut[4 * i + 1] = Math.min(1, Math.max(0, g)); lut[4 * i + 2] = Math.min(1, Math.max(0, b)); lut[4 * i + 3] = 1;
  }
  return lut;
}
export const CMAPS = {
  turbo: { label: 'turbo (FEA rainbow)', lut: turbo() },
  viridis: { label: 'viridis', lut: fromAnchors(VIRIDIS) },
  inferno: { label: 'inferno', lut: fromAnchors(INFERNO) },
  coolwarm: { label: 'cool–warm (signed)', lut: fromAnchors(COOLWARM) },
};
/** 'auto': signed fields get cool–warm (0 is the neutral middle), the rest turbo */
export function cmapFor(name, kind) { return name !== 'auto' ? name : kind === 'div' ? 'coolwarm' : 'turbo'; }

export function paintLegend(canvas, name, bands) {
  const lut = CMAPS[name].lut, ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  const img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    let t = x / (w - 1);
    if (bands > 0) t = (Math.floor(t * bands * 0.99999) + 0.5) / bands;
    const i = Math.round(t * 255);
    for (let y = 0; y < h; y++) { const o = 4 * (y * w + x); img.data[o] = lut[4 * i] * 255; img.data[o + 1] = lut[4 * i + 1] * 255; img.data[o + 2] = lut[4 * i + 2] * 255; img.data[o + 3] = 255; }
  }
  ctx.putImageData(img, 0, 0);
}

// geometry colours: oak tones per body role (half A light, half B a shade darker, pegs/keys walnut, rig steel)
export const BODY_RGB = { half_A: [0.86, 0.74, 0.56], half_B: [0.76, 0.62, 0.44], peg: [0.50, 0.34, 0.22], tool: [0.56, 0.58, 0.62], wood: [0.84, 0.72, 0.54] };
export const hexToRgb = (h) => { h = h.trim(); if (h.startsWith('rgb')) { const m = h.match(/[\d.]+/g).map(Number); return [m[0] / 255, m[1] / 255, m[2] / 255]; }
  if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]; };
