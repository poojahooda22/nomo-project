/**
 * The incompressible-fluid solver, GLSL ported verbatim from the teardown
 * (Stam stable-fluids scheme, Dobryakov pass lineage). Eleven passes share
 * one vertex stage that precomputes the four neighbour UVs.
 *
 * Two deliberate departures from textbook solvers, kept because they ARE
 * the look: only 2 Jacobi pressure iterations (mushy, smoky, nearly free)
 * and vorticity confinement at strength 10 (keeps the swirls curly).
 */

export const FLUID_VERTEX = /* glsl */ `
precision highp float;
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv, vL, vR, vT, vB;
uniform vec2 texelSize;
void main () {
  vUv = uv;
  vL = vUv - vec2(texelSize.x, 0.);
  vR = vUv + vec2(texelSize.x, 0.);
  vT = vUv + vec2(0., texelSize.y);
  vB = vUv - vec2(0., texelSize.y);
  gl_Position = vec4(position, 0., 1.);
}
`;

const HEADER = /* glsl */ `
precision highp float;
varying vec2 vUv, vL, vR, vT, vB;
`;

export const FLUID_CLEAR = HEADER + /* glsl */ `
uniform sampler2D baseMap;
uniform float value;
void main () {
  gl_FragColor = value * texture2D(baseMap, vUv);
}
`;

export const FLUID_CURL = HEADER + /* glsl */ `
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uVelocity, vL).y;
  float R = texture2D(uVelocity, vR).y;
  float T = texture2D(uVelocity, vT).x;
  float B = texture2D(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}
`;

export const FLUID_VORTICITY = HEADER + /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float ds;
void main () {
  float L = texture2D(uCurl, vL).x;
  float R = texture2D(uCurl, vR).x;
  float T = texture2D(uCurl, vT).x;
  float B = texture2D(uCurl, vB).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 vel = texture2D(uVelocity, vUv).xy;
  gl_FragColor = vec4(vel + force * ds, 0.0, 1.0);
}
`;

export const FLUID_DIVERGENCE = HEADER + /* glsl */ `
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uVelocity, vL).x;
  float R = texture2D(uVelocity, vR).x;
  float T = texture2D(uVelocity, vT).y;
  float B = texture2D(uVelocity, vB).y;
  vec2 C = texture2D(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}
`;

export const FLUID_PRESSURE = HEADER + /* glsl */ `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  float divergence = texture2D(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

export const FLUID_GRADIENT_SUBTRACT = HEADER + /* glsl */ `
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  vec2 velocity = texture2D(uVelocity, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`;

/* Displacement always uses the VELOCITY grid's texel. The dye runs at 2x
   sim resolution, and scaling by the dye's own (half-size) texel made the
   dye drift at half the speed of the flow carrying it. */
export const FLUID_ADVECTION = HEADER + /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 velTexelSize;
uniform float ds;
uniform float dissipation;
void main () {
  vec2 coord = vUv - ds * texture2D(uVelocity, vUv).xy * velTexelSize;
  gl_FragColor.rgb = dissipation * texture2D(uSource, coord).rgb;
  gl_FragColor.a = 1.;
}
`;

/* Capsule splat: the impulse is projected onto the segment between the
   previous and current pointer, so a fast flick leaves one continuous
   ribbon instead of a dotted line of blobs. */
export const FLUID_SPLAT = HEADER + /* glsl */ `
uniform sampler2D baseMap;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform vec2 prevPoint;
uniform float radius;
void main () {
  vec3 base = texture2D(baseMap, vUv).xyz;
  vec2 p  = point.xy;     p.x  *= aspectRatio;
  vec2 pp = prevPoint.xy; pp.x *= aspectRatio;
  vec2 uv = vUv;          uv.x *= aspectRatio;
  vec2 dP = p - pp;
  float ldP = length(dP);
  if (ldP < 1e-4) { gl_FragColor = vec4(base, 1.); return; }
  vec2 ndP = dP / ldP;
  float d = clamp(dot(ndP, uv - pp), 0., ldP);
  vec2 q = uv - (pp + ndP * d);
  vec3 splat = exp(-dot(q, q) / radius) * color;
  gl_FragColor = vec4(base + splat, 1.);
}
`;

/* The scene exhales into the sim: a silhouette of chosen geometry is
   rendered into `spawner`, and wherever it lands the fluid receives
   upward velocity (pass 1) and dye (pass 2). */
export const FLUID_SPAWNER = HEADER + /* glsl */ `
uniform sampler2D spawner;
uniform sampler2D baseMap;
uniform float amplification;
void main () {
  vec3 base  = texture2D(baseMap, vUv).xyz;
  vec3 spawn = texture2D(spawner, vUv).xyz;
  float power = dot(spawn, vec3(.333));
  base.y += power * amplification;
  gl_FragColor = vec4(base, 1.);
}
`;

/* The dye is never shown. It becomes a pseudo-normal map... */
export const FLUID_NORMAL = HEADER + /* glsl */ `
uniform sampler2D uDensity;
uniform float normalEpsilon;
void main () {
  float C = length(texture2D(uDensity, vUv).xy);
  float R = length(texture2D(uDensity, vR).xy);
  float B = length(texture2D(uDensity, vB).xy);
  vec2 dN = vec2(R - C, B - C);
  vec3 N = vec3(0., 1., 0.);
  vec2 eps = vec2(normalEpsilon, 0.);
  N = normalize(N + cross(dN.x * N + eps.xyy, dN.y * N + eps.yyx));
  gl_FragColor = vec4(N, 1.);
}
`;

/* ...and the normal map is edge-detected, so only thin wiry filaments
   along the swirl boundaries survive. That is the electric look. */
export const FLUID_NORMAL_DELTA = HEADER + /* glsl */ `
uniform sampler2D uNormal;
void main () {
  vec3 C = texture2D(uNormal, vUv).xyz;
  vec3 R = texture2D(uNormal, vR).xyz;
  vec3 B = texture2D(uNormal, vB).xyz;
  vec3 N = abs(R - C) + abs(B - C);
  gl_FragColor = vec4(N, 1.);
}
`;
