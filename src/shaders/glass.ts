/**
 * The glass feather - now the reference's actual TWO-PASS architecture,
 * ported from the shaders in its bundle (`b1` = GlassBack, `x1` = Glass):
 *
 *   PASS 1 - GlassBack (back faces, reads the scene withOUT the feather):
 *     five blue-noise-jittered samples between the exit points of two
 *     refraction rays (iorStart vs iorStart+iorDelta), each weighted by a
 *     spectrum colour from the LUT, and - THE PIECE OUR PORT WAS MISSING -
 *     each sample ADDS THE ENVIRONMENT MAP ALONG ITS OWN REFRACTED RAY
 *     (envRefraction). The env is a warm wooden studio: that refracted
 *     warmth IS the peach/orange glow inside the reference feather. The
 *     summed colour is then multiplied by the confetti-iridescence LUT
 *     (refractionIridescence) - the interior holographic patchwork.
 *
 *   PASS 2 - Glass (front faces, reads the scene WITH pass 1 in it):
 *     a single refraction tap (no loop - the dispersion already happened
 *     behind), transmittance, fringe, colorBoost, thickness decay tint,
 *     per-channel colour curves, then env reflection scaled by fresnel and
 *     the same iridescence LUT (reflectionIridescence).
 *
 * A one-pass port cannot fake this: whatever single formula it uses, the
 * front surface can only show the background - which is now saturated
 * blue - so the blade could only ever be blue. The interior colour of the
 * reference literally lives in a second scene texture.
 *
 * Uniform values come from the reference's settings timeline
 * (timelines/dev.glb): Glass_refractionVIri = [0.6, 0.15] is
 * (envRefraction, refractionIridescence); Glass_reflectionVIri = [1, 0.2]
 * is (envReflection, reflectionIridescence).
 */

const COMMON = /* glsl */ `
precision highp float;

#define pi 3.141592653589793
#define saturate1(x) clamp(x, 0., 1.)

uniform sampler2D map;
uniform sampler2D envMap;
uniform sampler2D colorsMap;
uniform sampler2D noiseMap;
uniform mat4 projectionMatrix;
uniform float seconds;
uniform float iorStart;
uniform float iorDelta;
uniform float useTransmittance;
uniform float fringeMix;
uniform float fringeCurve;
uniform vec3 fringeColor;

varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUv;
varying float vThickness;
varying vec3 vGlassColor;

/* Reference rolloff is -0.1 (ours was -0.45, which crushed the studio
   HDR's warm highlights to grey - and the warmth is the whole point). */
vec3 getEnvColor(vec3 ray) {
  vec2 uv = vec2(atan(ray.x, ray.z) * 0.5, asin(clamp(ray.y, -1., 1.)));
  uv = uv * (1. / pi) + 0.5;
  uv.x = fract(uv.x);
  return 1. - exp(-0.1 * texture2D(envMap, uv).rgb);
}

/* v = 0.75 is the confetti row: high-frequency saturated speckle. Facets a
   few degrees apart land on entirely different hues - that is the
   holographic patchwork of the reference blade. */
vec3 getIridescence(vec3 rd, vec3 n) {
  float thickness = 1. - abs(dot(n, rd));
  return texture2D(colorsMap, vec2(thickness * 0.3 + 0.08, 0.75)).rgb;
}

/* v = 0.25 is the dispersion spectrum (dark at both ends). */
vec3 mixToColor(float t) {
  return texture2D(colorsMap, vec2(clamp(t, 0.02, 0.98), 0.25)).rgb;
}

float fresnelSchlick(vec3 rd, vec3 n) {
  float cosTheta = abs(dot(rd, n));
  return 0.04 + 0.96 * pow(1. - cosTheta, 5.);
}
`;

const VERTEX_BODY = /* glsl */ `
attribute float _thickness;
attribute float _peaks;

uniform float seconds;
uniform float distancesFactor;
uniform float resetDistances;
uniform float peaksFactor;
uniform vec3 baseColor;
uniform vec3 peaksColor;

varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUv;
varying float vThickness;
varying vec3 vGlassColor;

mat3 rotY(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c, 0., s, 0., 1., 0., -s, 0., c);
}

void main() {
  float tip = clamp(position.y * 0.5 + 0.5, 0., 1.);
  float sway = sin(seconds * 0.55) * 0.12 + sin(seconds * 0.83 + 1.7) * 0.05;
  mat3 bend = rotY(sway * tip);
  vec3 pos = bend * position;
  pos.y += sin(seconds * 0.7) * 0.04;

  vec3 n = normalize(bend * normal);
#ifdef BACK_PASS
  n = -n;   // reference GlassBack: vNormal = -objectNormal
#endif

  vec4 worldPosition = modelMatrix * vec4(pos, 1.);
  vPosition = worldPosition.xyz;
  vNormal = normalize(mat3(modelMatrix) * n);
  vUv = uv;

  /* Glass_distResetX = [0, 1, 0]: resetDistances 1, so the march length is
     a CONSTANT 0.1 world units in the reference - both passes. */
  vThickness = mix(_thickness * distancesFactor, 0.1, resetDistances);
  vGlassColor = mix(baseColor, peaksColor, clamp(_peaks * peaksFactor, 0., 1.));

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  gl_Position.xy /= 1.25;
}
`;

export const GLASS_VERTEX = VERTEX_BODY;
export const GLASS_BACK_VERTEX = '#define BACK_PASS\n' + VERTEX_BODY;

/* ── PASS 1: dispersion + refracted environment, on the back faces ────── */

export const GLASS_BACK_FRAGMENT = COMMON + /* glsl */ `
#define samplesCount 5

uniform float uvShiftFactor;
uniform float envRefraction;
uniform float refractionIridescence;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDirection = normalize(vPosition - cameraPosition);

  vec3 refractionA = refract(viewDirection, normal, 1. / iorStart);
  vec3 refractionB = refract(viewDirection, normal, 1. / (iorStart + iorDelta));

  float transmittance = 1. - useTransmittance * fresnelSchlick(refractionA, normal);

  vec4 clipA = projectionMatrix * viewMatrix * vec4(vPosition + refractionA * vThickness, 1.0);
  clipA.xy /= 1.25;
  vec4 clipB = projectionMatrix * viewMatrix * vec4(vPosition + refractionB * vThickness, 1.0);
  clipB.xy /= 1.25;
  vec2 uvA = clamp(clipA.xy / clipA.w * 0.5 + 0.5, 0., 1.);
  vec2 uvB = clamp(clipB.xy / clipB.w * 0.5 + 0.5, 0., 1.);
  vec2 dUv = (uvB - uvA) * uvShiftFactor;

  vec2 noiseUv = fract(uvA * 777. + seconds);
  float blue = texture2D(noiseMap, noiseUv).r;

  float fringeness = fringeMix * pow(saturate1(1. - abs(dot(viewDirection, normal))), fringeCurve);

  vec3 color = vec3(0.);
  vec3 palAccum = vec3(0.);
  float dq = 1. / float(samplesCount);
  float mixFactor = blue * dq;
  for (int i = 0; i < samplesCount; i++) {
    vec2 uv = uvA + dUv * mixFactor;
    vec3 texel = texture2D(map, uv).rgb;

    /* THE MISSING WARMTH: the environment, seen through the glass along
       this sample's own refracted ray. The wooden-studio HDR is orange -
       this term is where the reference blade's peach interior comes from. */
    vec3 ray = normalize(mix(refractionA, refractionB, mixFactor));
    texel += getEnvColor(ray) * envRefraction;

    vec3 pal = mixToColor(mixFactor);
    palAccum += pal;
    texel = mix(texel, fringeColor, fringeness);
    color += texel * pal * transmittance;
    mixFactor += dq;
  }
  color /= max(palAccum, vec3(1e-4));

  vec3 iridescence = getIridescence(refractionA, normal) - 1.;
  color *= refractionIridescence * iridescence + 1.;

  gl_FragColor = vec4(color, 1.);
}
`;

/* ── PASS 2: the front surface, refracting the back pass ──────────────── */

export const GLASS_FRAGMENT = COMMON + /* glsl */ `
uniform float colorBoost;
uniform float decayFactor;
uniform float reflectionIridescence;
uniform float colorFactor;
uniform float colorCurve;
uniform float colorCurveR;
uniform float colorCurveG;
uniform float colorCurveB;
uniform float envReflection;
uniform float maxColorValue;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDirection = normalize(vPosition - cameraPosition);
  if (dot(normal, viewDirection) > 0.) normal = -normal;

  /* One tap. The five-sample spectral loop belongs to the BACK pass; the
     reference front surface just looks through at its result. */
  vec3 refraction = refract(viewDirection, normal, 1. / iorStart);
  vec4 clip = projectionMatrix * viewMatrix * vec4(vPosition + refraction * vThickness, 1.0);
  clip.xy /= 1.25;
  vec2 uv = clamp(clip.xy / clip.w * 0.5 + 0.5, 0., 1.);

  float transmittance = 1. - useTransmittance * fresnelSchlick(refraction, normal);
  vec3 color = texture2D(map, uv).rgb * transmittance;

  float fringeness = fringeMix * pow(saturate1(1. - abs(dot(viewDirection, normal))), fringeCurve);
  color = mix(color, fringeColor, fringeness);

  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = max((color - luminance) * colorBoost + luminance, 0.);

  float decay = exp(-vThickness * decayFactor);
  color *= mix(vGlassColor, vec3(1.), decay);

  vec3 iridescence = getIridescence(viewDirection, normal) - 1.;
  iridescence = reflectionIridescence * iridescence + 1.;

  color *= colorFactor;
  if (color.r < 1.) color.r = pow(color.r, colorCurve * colorCurveR);
  if (color.g < 1.) color.g = pow(color.g, colorCurve * colorCurveG);
  if (color.b < 1.) color.b = pow(color.b, colorCurve * colorCurveB);

  float fresnel = fresnelSchlick(viewDirection, normal);
  vec3 ray = reflect(viewDirection, normal);
  color += getEnvColor(ray) * envReflection * fresnel * iridescence;

  color = clamp(color, 0., maxColorValue);
  gl_FragColor = vec4(color, 1.);
}
`;
