import * as THREE from 'three';

/**
 * The two-row colour LUT the glass samples: row 0 (v=0.25) is the
 * dispersion spectrum the five refraction taps are weighted by, row 1
 * (v=0.75) is the iridescence ramp indexed by facing angle.
 *
 * Generated rather than loaded: a known layout beats guessing at the
 * reference sprite's row order, and a transparent texel in a loaded PNG
 * silently zeroes the spectral weights (which reads as black speckles).
 */
export function makeColorsLUT(): THREE.CanvasTexture {
  const w = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(w, 2);
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);

      /* Row 0 — visible spectrum, violet at t=0 to red at t=1, as smooth
         piecewise ramps over the classic hue order. */
      const hue = (1 - t) * 270; // 270 violet -> 0 red
      const c = hslToRgb(hue / 360, 1.0, 0.6);
      img.data[x * 4] = c[0];
      img.data[x * 4 + 1] = c[1];
      img.data[x * 4 + 2] = c[2];
      img.data[x * 4 + 3] = 255;

      /* Row 1 — thin-film iridescence: phase-shifted sinusoids. Deeper
         amplitude than a pastel so the facet colours actually read as
         rainbow sparkle on the rotating glass, not a faint tint. */
      const r = 0.62 + 0.38 * Math.sin(t * Math.PI * 4.0);
      const g = 0.62 + 0.38 * Math.sin(t * Math.PI * 4.0 + 2.1);
      const b = 0.62 + 0.38 * Math.sin(t * Math.PI * 4.0 + 4.2);
      const i = (w + x) * 4;
      img.data[i] = Math.round(r * 255);
      img.data[i + 1] = Math.round(g * 255);
      img.data[i + 2] = Math.round(b * 255);
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
