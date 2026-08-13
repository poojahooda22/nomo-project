/**
 * The glass feather: hand-written screen-space refraction with spectral
 * dispersion. The view ray is refracted at TWO different IORs, both exit
 * points are reprojected to screen space, and five blue-noise-jittered
 * samples of the scene (rendered without the feather) are taken along the
 * segment between them, each weighted by a spectrum colour from a LUT.
 * Red and violet genuinely exit at different places: chromatic dispersion
 * for the price of five texture taps.
 *
 * The mesh carries baked per-vertex _thickness and _peaks attributes.
 * Output is allowed up to 100.0: the HDR sparkle is what feeds the bloom.
 */

export const GLASS_VERTEX = /* glsl */ `
attribute float _thickness;
attribute float _peaks;
attribute vec4 tangent;

uniform float seconds;
uniform float distancesFactor;
uniform float resetDistances;
uniform float peaksFactor;
uniform vec3 baseColor;
uniform vec3 peaksColor;

varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBitangent;
varying vec2 vUv;
varying float vThickness;
varying vec3 vGlassColor;

/* The source rig was not exported, so the living quality comes from a
   gentle programmatic sway: a slow bend around Y whose strength grows
   toward the tip, plus a whole-body bob. */
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
  vec3 t = normalize(bend * tangent.xyz);

  vec4 worldPosition = modelMatrix * vec4(pos, 1.);
  vPosition = worldPosition.xyz;
  vNormal = normalize(mat3(modelMatrix) * n);
  vTangent = normalize(mat3(modelMatrix) * t);
  vBitangent = normalize(cross(vNormal, vTangent) * tangent.w);
  vUv = uv;

  vThickness = mix(_thickness * distancesFactor, 0.1, resetDistances);
  vGlassColor = mix(baseColor, peaksColor, clamp(_peaks * peaksFactor, 0., 1.));

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  gl_Position.xy /= 1.25;
}
`;

export const GLASS_FRAGMENT = /* glsl */ `
precision highp float;

#define pi 3.141592653589793
#define samplesCount 5

varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBitangent;
varying vec2 vUv;
varying float vThickness;
varying vec3 vGlassColor;

uniform sampler2D map;        // the scene rendered WITHOUT the feather
uniform sampler2D envMap;     // equirect HDR
uniform sampler2D colorsMap;  // row 0: dispersion spectrum, row 1: iridescence
uniform sampler2D noiseMap;   // blue noise
/* viewMatrix and cameraPosition are auto-declared by the material system's
   fragment prefix; only projectionMatrix needs declaring here. */
uniform mat4 projectionMatrix;
uniform float seconds;

uniform float iorStart;              // 1.214 captured
uniform float iorDelta;              // 0.909 captured
uniform float uvShiftFactor;         // 2.11
uniform float useTransmittance;
uniform float fringeMix;             // 0.86
uniform float fringeCurve;           // 4.08
uniform vec3 fringeColor;
uniform float colorBoost;            // 2
uniform float decayFactor;           // 20
uniform float reflectionIridescence; // 0.28
uniform float colorFactor;           // 2
uniform float colorCurve;            // 1.34
uniform float colorCurveR;
uniform float colorCurveG;
uniform float colorCurveB;
uniform float envReflection;
uniform float maxColorValue;         // 100 -> feeds the bloom

float saturate1(float x) { return clamp(x, 0., 1.); }
vec2 saturate2(vec2 x) { return clamp(x, 0., 1.); }

float fresnelSchlick(vec3 rd, vec3 n) {
  float cosTheta = saturate1(dot(-rd, n));
  float f0 = 0.04;
  return f0 + (1. - f0) * pow(1. - cosTheta, 5.);
}

vec3 getEnvColor(vec3 ray) {
  vec2 uv = vec2(atan(ray.x, ray.z) * 0.5, asin(clamp(ray.y, -1., 1.)));
  uv = uv * (1. / pi) + 0.5;
  uv.x = fract(uv.x);
  vec3 color = texture2D(envMap, uv).rgb;
  // Rolloff tuned to this HDR: at -0.1 the studio map reflected near-black.
  return 1. - exp(-0.45 * color);
}

vec3 getIridescence(vec3 rd, vec3 n) {
  float thickness = 1. - abs(dot(n, rd));
  return texture2D(colorsMap, vec2(thickness * 0.3 + 0.08, 0.75)).rgb;
}

vec3 mixToColor(float t) {
  return texture2D(colorsMap, vec2(clamp(t, 0.02, 0.98), 0.25)).rgb;
}

vec3 getNormal() {
  // Subtle procedural ridging in tangent space keeps the low-poly surface
  // from reading as flat facets.
  vec3 n = normalize(vNormal);
  vec3 t = normalize(vTangent);
  vec3 b = normalize(vBitangent);
  // Enough to break up flat facets; at 0.04 this striped the blade white.
  float ridge = sin(vUv.y * 90. + vUv.x * 14.) * 0.012;
  return normalize(n + t * ridge);
}

void main() {
  vec3 normal = getNormal();
  vec3 viewDirection = normalize(vPosition - cameraPosition);
  if (dot(normal, viewDirection) > 0.) normal = -normal;

  vec3 refractionA = refract(viewDirection, normal, 1. / iorStart);
  vec3 refractionB = refract(viewDirection, normal, 1. / (iorStart + iorDelta));

  float transmittance = 1. - useTransmittance * fresnelSchlick(refractionA, normal);

  vec4 clipA = projectionMatrix * viewMatrix * vec4(vPosition + refractionA * vThickness, 1.0);
  clipA.xy /= 1.25;
  vec4 clipB = projectionMatrix * viewMatrix * vec4(vPosition + refractionB * vThickness, 1.0);
  clipB.xy /= 1.25;
  vec2 uvA = saturate2(clipA.xy / clipA.w * 0.5 + 0.5);
  vec2 uvB = saturate2(clipB.xy / clipB.w * 0.5 + 0.5);

  vec2 noiseUv = fract(uvA * 777. + seconds);
  float blue = texture2D(noiseMap, noiseUv).r;

  vec3 color = vec3(0.);
  vec3 palAccum = vec3(0.);
  float dq = 1. / float(samplesCount);
  float mixFactor = blue * dq;
  vec2 dUv = (uvB - uvA) * dq * uvShiftFactor;
  vec2 uv = uvA + dUv * blue;
  for (int i = 0; i < samplesCount; i++) {
    vec3 texel = texture2D(map, uv).rgb;
    vec3 pal = mixToColor(mixFactor);
    palAccum += pal;
    color += texel * pal;
    uv += dUv;
    mixFactor += dq;
  }
  color *= transmittance / max(palAccum, vec3(1e-4));

  float fringeness = fringeMix * pow(saturate1(1. - abs(dot(viewDirection, normal))), fringeCurve);
  color = mix(color, fringeColor, fringeness);

  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = (color - luminance) * colorBoost + luminance;

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
