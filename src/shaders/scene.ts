/**
 * Scene-layer shaders. Every vertex stage ends with the overscan trick:
 * gl_Position.xy /= 1.25. The whole scene draws 25% larger than the frame
 * so refraction, haze and the post halo can sample beyond the visible edge
 * without ever finding a black border; the final composite un-zooms.
 */

export const OVERSCAN = 1.25;

/* ── Background: deep blue radial pool around the beam ─────────────────── */

export const BG_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.9999, 1.);
  gl_Position.xy /= ${OVERSCAN};
}
`;

export const BG_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float seconds;
void main() {
  vec2 c = vUv - vec2(0.5, 0.55);
  float r = length(c * vec2(1.6, 1.));
  // The reference frame is near-black away from the beam.
  vec3 deep = vec3(0.001, 0.001, 0.007);
  vec3 pool = vec3(0.003, 0.008, 0.035);
  vec3 col = mix(pool, deep, smoothstep(0.05, 0.85, r));
  float column = exp(-10. * abs(vUv.x - 0.5)) * smoothstep(0.0, 0.55, vUv.y);
  col += vec3(0.025, 0.04, 0.125) * column;
  // A bright core directly behind the feather: this is what the glass
  // refracts and disperses. Without it the dispersion has nothing to bend.
  vec2 cv = (vUv - vec2(0.5, 0.5)) * vec2(2.2, 1.1);
  col += vec3(0.5, 0.62, 1.2) * exp(-16. * dot(cv, cv));
  gl_FragColor = vec4(col, 1.);
}
`;

/* ── The cloud plane: consumer of both simulations ──────────────────────
   type 0: fluid mode — heat-haze distortion + pink emission along the
   dye's edge filaments. type 1: ripple mode — slope-based refraction and
   blue tint hugging the cursor. */

export const CLOUD_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec2 vScreenUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0., 1.);
  gl_Position.xy /= ${OVERSCAN};
  vScreenUv = gl_Position.xy * 0.5 + 0.5;
}
`;

export const CLOUD_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec2 vScreenUv;
uniform sampler2D normalMap;
uniform sampler2D deltaMap;
uniform sampler2D map;
uniform sampler2D simpleMap;
uniform vec3 color;
uniform float emissionFactor, emissionWhiteness, interpol, type, blueness, opacity;

float saturate1(float x) { return clamp(x, 0., 1.); }

uniform vec2 simpleTexel;
uniform float hazeScale;

float rippleHeight(vec2 uv) {
  vec2 texel = texture2D(simpleMap, uv).xy;
  return mix(texel.y, texel.x, interpol);
}

void main() {
  /* The slope is measured by sampling the height field at its own texel
     offsets and is NEVER normalised: normalising a y-less vector returns
     a full-length unit vector for the faintest wave, which painted a
     quad-quantised blue wash over the whole frame. Magnitude is signal. */
  vec2 offset = vec2(0.);
  vec2 slope = vec2(0.);
  if (type < 1.) {
    vec3 n0 = texture2D(normalMap, vUv).xyz;
    offset = n0.xz * hazeScale;
  } else {
    float hl = rippleHeight(vUv - vec2(simpleTexel.x, 0.));
    float hr = rippleHeight(vUv + vec2(simpleTexel.x, 0.));
    float hb = rippleHeight(vUv - vec2(0., simpleTexel.y));
    float ht = rippleHeight(vUv + vec2(0., simpleTexel.y));
    slope = vec2(hr - hl, ht - hb);
    offset = slope * hazeScale * 4.;
  }

  vec2 uv = vScreenUv + offset;
  vec3 final = texture2D(map, uv).rgb;

  if (type < 1.) {
    vec3 emi = texture2D(deltaMap, vUv).xyz;
    float luminance = dot(emi, vec3(0.2126, 0.7152, 0.0722));
    emi = mix(emi, vec3(luminance), emissionWhiteness);
    final += emi * emissionFactor * color * (1. - type);
  }

  if (type > 0.) {
    /* Gated by real wave energy and left UNSATURATED, so a faint distant
       ripple stays faint instead of being promoted to full blue. */
    float energy = min(length(slope) * 1.5, 1.);
    final.b += energy * energy * blueness;
  }

  vec2 vig = vUv * (1. - vUv) * 0.99 + 0.005;
  float a = pow(16. * vig.x * vig.y, 1.1);
  gl_FragColor = vec4(final, a * opacity);
}
`;

/* ── The light beam: layered additive planes, exponential height fade ─── */

export const BEAM_VERTEX = /* glsl */ `
varying vec3 vPosition;
varying vec2 vUv;
void main() {
  vPosition = position;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  gl_Position.xy /= ${OVERSCAN};
}
`;

/* Adaptation over the captured shader: a soft horizontal profile so the
   plane's rectangular border never shows. The captured version had only
   the vertical falloff; its horizontal softness must have lived in
   geometry or a texture that was not recoverable. */
export const BEAM_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vPosition;
varying vec2 vUv;
uniform vec3 color;
uniform float intensity, falloff, opacity;
void main() {
  vec3 res = color * intensity;
  float y = vPosition.y;
  res *= exp(-falloff * abs(y)) * step(0., y);
  float edge = 1. - abs(vUv.x - 0.5) * 2.;
  res *= edge * edge * (3. - 2. * edge);
  gl_FragColor = vec4(res, opacity);
}
`;

/* ── Dust: one gl_Points cloud, fountain-recycled in the vertex shader ── */

export const DUST_VERTEX = /* glsl */ `
attribute float aBirthTime, aSize, aRandomOpacity, aRandomSpeed;
attribute vec2 aDrift;
uniform float seconds, lifeTime, speed, baseSize;
varying float vOpacity;
void main() {
  float localTime = mod(seconds + aBirthTime, lifeTime);
  float progress = localTime / lifeTime;
  vec3 pos = position;
  pos.y  += progress * speed * aRandomSpeed;
  pos.xz += aDrift * progress;
  vOpacity = smoothstep(0., 0.1, progress) * (1. - smoothstep(0.8, 1., progress));
  vOpacity *= aRandomOpacity;
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.);
  gl_PointSize = (baseSize + aSize) * (150. / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.xy /= ${OVERSCAN};
}
`;

export const DUST_FRAGMENT = /* glsl */ `
precision highp float;
varying float vOpacity;
uniform vec3 color;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.;
  float a = smoothstep(1., 0.2, d) * vOpacity;
  gl_FragColor = vec4(color, a);
}
`;

/* ── Cursor trail overlay: noise-wobbled blue readout of the ripple sim.
   Drawn AFTER the composite, so no overscan here. ─────────────────────── */

export const TRAIL_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0., 1.);
}
`;

export const TRAIL_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D trailMap, noisesMap;
uniform float seconds;
void main() {
  vec2 panningUV = -4. * vUv;  panningUV.y += seconds;
  vec4 noise = texture2D(noisesMap, panningUV);
  vec2 distortedUV = vUv + noise.rg * 0.01;
  /* Two traps live here. The wave field oscillates below zero, and
     blending negative colour with negative alpha SUBTRACTS blue from the
     frame (prints yellow). And trailMap is an RG texture: its .rgb is
     (height, prevHeight, 0) - the blue channel is zero BY FORMAT, so
     tinting the raw channels can only ever produce yellow. The colour must
     be built from the height scalar. */
  float h = min(max(texture2D(trailMap, distortedUV).r, 0.), 2.);
  gl_FragColor = vec4(vec3(0.1, 0.1, 1.) * h, clamp(h * 0.25, 0., 1.));
}
`;

/* ── Spawner override: flat white silhouette for the fluid injector ───── */

export const SPAWNER_VERTEX = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}
`;

export const SPAWNER_FRAGMENT = /* glsl */ `
precision highp float;
void main() {
  gl_FragColor = vec4(1.);
}
`;
