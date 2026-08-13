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
  vec3 deep = vec3(0.004, 0.004, 0.028);
  vec3 pool = vec3(0.012, 0.03, 0.14);
  vec3 col = mix(pool, deep, smoothstep(0.05, 0.85, r));
  // vertical column of light behind the feather: what the glass refracts
  float column = exp(-10. * abs(vUv.x - 0.5)) * smoothstep(0.0, 0.55, vUv.y);
  col += vec3(0.1, 0.16, 0.5) * column;
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

void main() {
  vec3 normal0 = type < 1. ? texture2D(normalMap, vUv).xyz : vec3(0.);
  vec3 normal1 = vec3(0.);
  if (type > 0.) {
    vec2 texel = texture2D(simpleMap, vUv).xy;
    float h = mix(texel.y, texel.x, interpol);
    normal1 = vec3(dFdx(h), 0., dFdy(h));
  }
  vec3 normal = normalize(mix(normal0, normal1, type) + vec3(0., 1e-5, 0.));

  vec2 uv = vScreenUv + normal.xz;
  vec3 final = texture2D(map, uv).rgb;

  if (type < 1.) {
    vec3 emi = texture2D(deltaMap, vUv).xyz;
    float luminance = dot(emi, vec3(0.2126, 0.7152, 0.0722));
    emi = mix(emi, vec3(luminance), emissionWhiteness);
    final += emi * emissionFactor * color * (1. - type);
  }

  if (type > 0.) {
    final.b += (saturate1(normal.x) + saturate1(-normal.z)) * blueness;
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
  vec3 trail = texture2D(trailMap, distortedUV).rgb;
  gl_FragColor = vec4(trail * vec3(0.1, 0.1, 1.), trail.r * 0.25);
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
