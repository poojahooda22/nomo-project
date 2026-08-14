import * as THREE from 'three';

/**
 * The colour LUT the glass samples. This is no longer a guess: it is a
 * reconstruction of the 1024x2 LUT the reference ships as an inline
 * base64 PNG, read straight out of its bundle.
 *
 *   v = 0.25  ->  the DISPERSION spectrum used by mixToColor(). It is a
 *                 spectral locus, not an HSL rainbow: it FADES TO BLACK at
 *                 both ends (violet 7,0,26 -> red 11,3,0). Those dark ends
 *                 are what stop the five refraction taps from painting a
 *                 saturated red/violet rim on every silhouette edge.
 *
 *   v = 0.75  ->  the IRIDESCENCE ramp. In the reference this row is NOT a
 *                 smooth gradient - it is high-frequency saturated confetti.
 *                 Sampled at thickness*0.3+0.08, neighbouring facets land on
 *                 wildly different hues, and THAT is the pink/teal/cream
 *                 speckle over the reference feather. A smooth pastel ramp
 *                 (what was here before) can only ever produce one flat tint.
 *
 * Row order matters and was previously inverted. THREE uploads textures with
 * flipY = true by default, so canvas row 0 becomes v = 0.75 - the old file
 * wrote the spectrum into row 0 and therefore fed the IRIDESCENCE row to the
 * dispersion taps and vice versa. flipY is now explicitly false so the row
 * indices below mean what they say.
 */

// 20 box-averaged samples of the reference dispersion row, 0-255.
const SPECTRUM: [number, number, number][] = [
  [7, 0, 26], [31, 0, 60], [38, 0, 87], [25, 6, 106], [2, 58, 118],
  [0, 113, 122], [0, 156, 118], [0, 188, 108], [18, 208, 89], [92, 218, 63],
  [157, 216, 32], [204, 203, 37], [235, 180, 61], [250, 145, 65], [249, 99, 50],
  [231, 48, 14], [197, 25, 0], [147, 29, 0], [81, 20, 0], [11, 3, 0],
];

export function makeColorsLUT(): THREE.CanvasTexture {
  const w = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(w, 2);

    // Row 0 -> v = 0.25: the dispersion spectrum, linearly resampled.
    for (let x = 0; x < w; x++) {
      const f = (x / (w - 1)) * (SPECTRUM.length - 1);
      const i0 = Math.floor(f);
      const i1 = Math.min(SPECTRUM.length - 1, i0 + 1);
      const t = f - i0;
      const o = x * 4;
      for (let ch = 0; ch < 3; ch++) {
        img.data[o + ch] = Math.round(SPECTRUM[i0][ch] * (1 - t) + SPECTRUM[i1][ch] * t);
      }
      img.data[o + 3] = 255;
    }

    // Row 1 -> v = 0.75: saturated per-texel confetti. Deterministic so the
    // build is reproducible; statistically identical to the reference row.
    let s = 0x9e3779b9;
    const rng = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let x = 0; x < w; x++) {
      const c = hslToRgb(rng(), 1.0, 0.15 + rng() * 0.65);
      const o = (w + x) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false; // row 0 == v 0.25 == dispersion, row 1 == v 0.75 == iridescence
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
