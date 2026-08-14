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
  vec3 deep = vec3(0.0008, 0.0010, 0.0045);
  vec3 pool = vec3(0.0020, 0.0045, 0.0180);
  vec3 col = mix(pool, deep, smoothstep(0.05, 0.85, r));
  float column = exp(-10. * abs(vUv.x - 0.5)) * smoothstep(0.0, 0.55, vUv.y);
  col += vec3(0.014, 0.024, 0.078) * column;
  // A bright core directly behind the feather: this is what the glass
  // refracts and disperses. Without it the dispersion has nothing to bend.
  /* Tight and modest. sRGB output LIFTS the darks: a linear 0.2 displays
     as ~0.5, so a wide gaussian at amplitude 1.2 reads as a giant white
     ellipse swallowing half the frame (it did). The glass only needs a
     hot SMALL core to disperse; the width comes from bloom, not from the
     background. */
  /* Aspect-corrected so the halo is a CIRCLE. The old (2.2, 1.1) scaling
     stretched it into a lens twice as wide as tall, which is why widening
     it flooded the top corners with navy instead of pooling around the
     asset the way the reference does. */
  vec2 cv = (vUv - vec2(0.5, 0.47)) * vec2(1.76, 1.1);
  float d2 = dot(cv, cv);
  /* THREE lobes, not one. The previous single tight gaussian is why the
     reference's big soft blue disc around the asset was missing entirely.
     The reason the old WIDE gaussian had to be deleted was not its width,
     it was its RED: sRGB lifts the darks, so a wide lobe with r ~ g ~ b
     reads as a white ellipse. Keep the wide lobes strongly blue-dominant
     (r about 1/8 of b) and they read as blue haze at any amplitude. */
  col += vec3(0.016, 0.048, 0.200) * exp(-5.0  * d2);   // outer blue disc
  col += vec3(0.040, 0.100, 0.400) * exp(-17.0 * d2);   // inner blue bloom

  /* The backlight the feather actually refracts, and the reason it was a
     flat blue crystal. The glass is a lens: whatever is behind it is what
     it shows, and colorBoost 1.55 then SATURATES that. With only a blue
     halo behind it, a blue-dominant sample gets its red crushed toward
     zero and the feather can be nothing but blue. The reference has a hot
     near-white shaft standing behind the asset, so the taps come back
     bright and near-neutral and the dispersion palette + glass tint are
     free to colour them. Elongated on Y so it backs the whole blade, not
     just its middle. */
  vec2 hv = (vUv - vec2(0.5, 0.47)) * vec2(24.0, 2.5);
  /* The shaft comes DOWN and dies at the blade's base - in the reference
     nothing is lit below the asset. Without this cutoff it ran straight
     off the bottom of the frame as a second beam.

     SATURATED blue, never near-neutral. The tonemapper desaturates any
     overbright pixel toward white and sRGB lifts the mids, so a neutral
     shaft here reads as white fog poured over the blade - the reference
     frame has no white anywhere except the beam's very core. Keep red
     near an eighth of blue and the shaft stays a blue glow at any
     amplitude. The glass no longer needs neutral light behind it: its
     sparkle comes from the fringe, the iridescence LUT and the env map. */
  float shaftFade = smoothstep(0.16, 0.40, vUv.y);
  col += vec3(0.045, 0.105, 0.340) * exp(-dot(hv, hv)) * shaftFade;
  col += vec3(0.030, 0.060, 0.180) * exp(-42.0 * d2);   // its soft spill
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
