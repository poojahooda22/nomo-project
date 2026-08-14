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

/* THE BLUE CIRCLE, as one legible radial profile.
 *
 * Geometry: everything is a function of ONE distance d from the glow
 * centre (0.5, 0.47) in aspect-corrected UV, so the glow is a true circle
 * that cannot smear into an ellipse or a shaft. There are no elongated
 * lobes, no vertical bands, and nothing near-neutral anywhere in this
 * shader - the beam is separate slim geometry in the scene.
 *
 * Radial budget (fractions are of the glow radius R = 0.62 UV, which the
 * composite's 1.25 un-zoom shows as about 55-60 percent of frame height -
 * measure the reference and that is the figure you get):
 *   d = 0.00        bright royal core behind the blade
 *   d = 0.35 R      half the core brightness
 *   d = 1.00 R      under a tenth - the visible edge of the circle
 *   beyond          the deep floor, then black corners
 *
 * Colour: the ratios are set for what they DISPLAY as, not what they read
 * as. sRGB compresses ratios, so to SHOW green at a quarter of blue (the
 * reference's halo, one eyedropper away) the shader must FEED green near
 * blue/18 and red near blue/25. Every term below obeys r <= b/14,
 * g <= b/9. If any future edit adds a glow with more red or green than
 * that, it will read whitish - that exact mistake has been made and
 * reverted three times in this file's history. */
void main() {
  /* Aspect-corrected offset from the glow centre. 1.6 is the design
     aspect; at other window shapes the circle stays a circle because both
     axes use the same UV frame the composite un-zooms. */
  vec2 cv = (vUv - vec2(0.5, 0.47)) * vec2(1.6, 1.0);
  float d2 = dot(cv, cv);

  /* The floor: corners are BLACK. Not navy - black with the faintest blue
     cast so the fluid's dark gaps still read as night rather than void. */
  vec3 col = vec3(0.00006, 0.00008, 0.00080);

  /* The circle. Three concentric gaussians of one hue family, exponents
     chosen so the glow has ENDED by half a frame from centre:
       exp(-24 d2): the core right behind the blade (its backlight)
       exp(-10 d2): the body of the circle
       exp(- 8.0 d2): the last soft skirt. NOTE the overscan: the
                      composite un-zoom means a screen corner sits at only
                      d2 of about 0.5 in this shader's UV, not 1.0 - so
                      the skirt must already be dead at d2 = 0.5
                      (exp(-4) = 0.018 of a small amplitude). The old
                      outer lobe used exp(-2.3 d2) at 6x this amplitude,
                      still 40 percent alive at the corners - that single
                      number was the blue-flooded canvas. */
  col += vec3(0.0016, 0.0034, 0.042) * exp(-9.5 * d2);
  col += vec3(0.0090, 0.0180, 0.230) * exp(-10.0 * d2);
  col += vec3(0.0220, 0.0420, 0.520) * exp(-24.0 * d2);

  /* The beam's landing glow: a SMALL brightening where the beam meets the
     blade tip, so the slim beam geometry does not look pasted on. Tight
     (exp(-90)) and the same hue family - this is NOT a shaft. */
  vec2 tv = (vUv - vec2(0.5, 0.60)) * vec2(1.6, 1.0);
  col += vec3(0.0140, 0.0300, 0.340) * exp(-90.0 * dot(tv, tv));

  gl_FragColor = vec4(col, 1.);
}
`;

/* ── The cloud plane: consumer of both simulations ──────────────────────
   type 0: fluid mode — heat-haze distortion + pink emission along the
   dye's edge filaments. type 1: ripple mode — slope-based refraction and
   blue tint hugging the cursor. */

/* Full model/view/projection transform so the SAME shader serves both the
   tilted 3D fluid disc (rendered with the main camera — this is what turns
   the fluid into the reference's receding ellipse instead of a flat
   screen overlay) and the fullscreen ripple quad (rendered with a default
   Camera whose matrices are identity, so it degenerates to a screen quad).
   The clip position is passed whole and divided per-fragment: interpolating
   an already-divided screen UV across a perspective-tilted plane warps it. */
export const CLOUD_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec4 vClip;
void main() {
  vUv = uv;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  clip.xy /= ${OVERSCAN};
  gl_Position = clip;
  vClip = clip;
}
`;

export const CLOUD_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vClip;
uniform sampler2D normalMap;
uniform sampler2D deltaMap;
uniform sampler2D map;
uniform sampler2D simpleMap;
uniform vec3 color;
uniform float emissionFactor, emissionWhiteness, interpol, type, blueness, opacity;
uniform vec3 rippleTint;

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

  vec2 vScreenUv = vClip.xy / vClip.w * 0.5 + 0.5;
  vec2 uv = vScreenUv + offset;
  vec3 final = texture2D(map, uv).rgb;

  if (type < 1.) {
    vec3 emi = texture2D(deltaMap, vUv).xyz;
    float luminance = dot(emi, vec3(0.2126, 0.7152, 0.0722));
    /* THIS is where the blue was coming from. The per-channel "chromatic
       fringing" block that used to sit here mapped emi.b (the |d n.z| edge
       measurement, which is just as strong as |d n.x|) onto CYAN, so every
       filament came out magenta+cyan == pale blue.

       The reference does no such thing. Its emission is one line:
           emi = mix(emi, vec3(luminance), emissionWhiteness);
           final += emi * emissionFactor * color;
       and its color uniform is pure WHITE. The pink is not painted on - it is the
       delta texture's own channel structure. The fluid normal is built
       around vec3(0,1,0), so |d n.x| and |d n.z| carry all the signal while
       |d n.y| stays near zero: R and B lit, G dark, i.e. magenta. Show the
       channels honestly and the filaments are pink for free. */
    vec3 emiCol = mix(emi, vec3(luminance), emissionWhiteness) * color;
    final += emiCol * emissionFactor * (1. - type);
  }

  if (type > 0.) {
    /* The reference adds this straight into .b, but only at blueness <= 0.1
       (its GUI clamps the slider there). This build was running 0.28 into
       .b AND a pure-blue trail overlay on top, which is the blue halo that
       followed the cursor. It is a tint uniform now: feed it magenta and
       the cursor wake belongs to the same palette as the filaments.
       Still gated by real wave energy and left UNSATURATED, so a faint
       distant ripple stays faint instead of being promoted to full tint. */
    float energy = min(length(slope) * 1.5, 1.);
    final += energy * energy * blueness * rippleTint;
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
uniform float wanderAmp, wanderFreq;
varying float vOpacity;
void main() {
  float localTime = mod(seconds + aBirthTime, lifeTime);
  float progress = localTime / lifeTime;
  vec3 pos = position;
  pos.y  += progress * speed * aRandomSpeed;
  pos.xz += aDrift * progress;

  /* Serpentine wander. aDrift alone is a LINEAR offset, so a mote can only
     ever travel in a straight line from where it spawned - which is why the
     rising sparks read as ruled pencil strokes. Two out-of-phase sines on x
     and z bend that line into a climbing zigzag. The rate is scaled per
     particle (aRandomOpacity is already a stable 0.4-1.0 per-mote random)
     so they never oscillate in lockstep, and the amplitude grows with
     progress so each spark leaves its source cleanly and widens as it
     rises. wanderAmp is 0 for the ambient dust, which is unchanged. */
  float ph = aBirthTime * 9.7;
  float rate = wanderFreq * (0.7 + aRandomOpacity * 0.6);
  float sway = wanderAmp * progress;
  pos.x += sin(progress * rate + ph) * sway;
  pos.z += cos(progress * rate * 0.8 + ph * 1.6) * sway * 0.7;
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
uniform vec3 trailColor;
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
  /* Was vec3(0.1, 0.1, 1.) - a pure blue smear painted over the finished
     frame, drawn AFTER post so bloom never softened it. It was the single
     most blue thing on screen whenever the pointer moved. Same magenta as
     the filaments now, and dimmer, so it reads as the wake of the fluid
     rather than a separate blue light source. */
  gl_FragColor = vec4(trailColor * h, clamp(h * 0.18, 0., 1.));
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
