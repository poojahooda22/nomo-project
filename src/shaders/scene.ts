/**
 * Scene-layer shaders. Every vertex stage ends with the overscan trick:
 * gl_Position.xy /= 1.25. The whole scene draws 25% larger than the frame
 * so refraction, haze and the post halo can sample beyond the visible edge
 * without ever finding a black border; the final composite un-zooms.
 */

export const OVERSCAN = 1.25;

/* ── Background: the black ground the fluid is drawn on ────────────────── */

export const BG_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.9999, 1.);
  gl_Position.xy /= ${OVERSCAN};
}
`;

/*
  Flat black, and it still has to be a real pass rather than a clear colour.

  The fluid consumer does not draw ONTO the frame - it SAMPLES this target as
  its base (`final = texture2D(map, uv)`) and adds its emission on top, with
  the sample point displaced by the haze. Skip the pass and it reads an empty
  target through that displacement, so the filaments lose the ground they sit
  on at exactly the moment the cursor disturbs it.

  Not pure zero: a hair of blue in the floor keeps the dark gaps between
  filaments reading as night rather than as a hole punched in the page, and
  it is far below the threshold where the bloom can find it.
*/
export const BG_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float seconds;

void main() {
  gl_FragColor = vec4(vec3(0.0006, 0.0006, 0.0011), 1.);
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
