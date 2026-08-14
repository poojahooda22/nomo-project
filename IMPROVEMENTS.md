# From "blue water" to the Noomo look — what was wrong and every change

I pulled your latest master, ran it headless, and iterated with screenshots
until it matched the reference's character. Two of the gaps were structural
(not tuning), and one "obvious" fix turned out to target the wrong layer —
each claim below was verified by isolating layers (`?nofluidcloud`,
`?noripplecloud`, `?nofeather`, `?nopost`, `?notrail`).

Apply everything below (or unzip `improved-src.zip` over `src/`). Nothing is
pushed to your repo.

---

## 1. STRUCTURAL — the fluid was wallpaper, the reference is a floor

Everything else is secondary to this. On the Noomo site the filaments live on
a huge TILTED PLANE in the 3D scene — that's why they form a receding ellipse
*around* the feather with perspective flow. Your build drew the fluid on a
fullscreen overlay, so no matter how good the sim was, it could only ever
look like flat blue wallpaper behind the text.

Three coordinated changes:

**a) The disc** (`main.ts`) — the fluid consumer becomes a scene object
rendered with the main camera:

```ts
const discScene = new THREE.Scene();
const fluidDisc = new THREE.Mesh(new THREE.PlaneGeometry(11, 8), fluidCloudMat);
fluidDisc.rotation.x = -1.02;          // leaning back: floor-like ellipse
fluidDisc.position.set(0, -0.2, -0.4);
fluidDisc.frustumCulled = false;
discScene.add(fluidDisc);
// frame loop:
renderer.render(discScene, camera);    // perspective disc
renderer.render(cloudScene, blitCam);  // fullscreen ripple shimmer stays 2D
```

**b) The cloud vertex shader** (`scene.ts`) — it needs real transforms now,
and the screen UV for the haze must be divided PER FRAGMENT (interpolating an
already-divided UV across a perspective-tilted plane warps it):

```glsl
varying vec2 vUv;
varying vec4 vClip;
void main() {
  vUv = uv;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  clip.xy /= 1.25;
  gl_Position = clip;
  vClip = clip;
}
// fragment:  vec2 vScreenUv = vClip.xy / vClip.w * 0.5 + 0.5;
```

Because the ripple quad renders with a default `THREE.Camera` (identity
matrices), the same shader still works for it unchanged.

**c) Cursor and spawner must follow the fluid into disc-UV space:**

```ts
// Pointer: raycast onto the disc. The *1.25 undoes the overscan shrink.
function feedPointer(x: number, y: number): void {
  ripple.setPointer(x, y);                       // ripple stays screen-space
  ndc.set((x * 2 - 1) * 1.25, (y * 2 - 1) * 1.25);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(fluidDisc, false)[0];
  if (hit && hit.uv) fluid.setPointer(hit.uv.x, hit.uv.y);
}

// Spawner: ortho camera PARENTED TO THE DISC, frustum = disc half-extents,
// so its render is pixel-aligned with disc UV (the old main-camera render
// only matched a fullscreen fluid).
const spawnerCam = new THREE.OrthographicCamera(-5.5, 5.5, 4, -4, 0.1, 12);
spawnerCam.position.set(0, 0, 6);
fluidDisc.add(spawnerCam);
// frame loop: renderer.render(featherScene, spawnerCam);
```

## 2. STRUCTURAL — nothing was stirring the fluid at idle

The reference disc is COVERED in filaments before you ever touch the mouse.
A breathing spawner alone can't do that. Added ember churn — four invisible
emitters orbiting the disc centre on incommensurate periods, dragging capsule
splats every frame (all through the same MAX_IMPULSE cap as the mouse):

```ts
const EMBERS = [
  { r: 0.13, rv: 0.6,  w: 0.5,   p: 0.0 },
  { r: 0.24, rv: 0.55, w: -0.37, p: 2.1 },
  { r: 0.36, rv: 0.5,  w: 0.26,  p: 4.4 },
  { r: 0.44, rv: 0.45, w: -0.19, p: 1.2 },
];
const emberPrev = EMBERS.map(() => new THREE.Vector2(-1, -1));
function stirEmbers(seconds: number): void {
  for (let i = 0; i < EMBERS.length; i++) {
    const e = EMBERS[i];
    const a = seconds * e.w * Math.PI * 2 * 0.15 + e.p;
    const wobble = 1 + 0.25 * Math.sin(seconds * 0.9 + e.p * 3.1);
    const x = 0.5 + Math.cos(a) * e.r * wobble;
    const y = 0.5 + Math.sin(a) * e.r * e.rv * wobble;
    const prev = emberPrev[i];
    if (prev.x >= 0) {
      const dx = x - prev.x, dy = y - prev.y;
      if (Math.hypot(dx, dy) > 1e-5) fluid.splatAt(x, y, dx, dy);
    }
    prev.set(x, y);
  }
}
// frame loop, before fluid.step(): stirEmbers(seconds);
```

Plus: `SPAWN_VELOCITY 0.07`, `SPAWN_DENSITY 0.024`, `DYE_STAMP_SCALE 0.12 →
0.3` (0.12 gave soft watery gradients — your "blue water"; crisper dye edges
are what the edge detector turns into wire-thin lines).

## 3. The filament colour — chromatic fringing, not one flat tint

The delta texture's channels are |Δnormal.x|, |Δnormal.y|, |Δnormal.z| —
three DIFFERENT edge measurements that peak at slightly different spots along
a filament. The reference's magenta-core/cyan-rim fringing comes from showing
that structure. Collapsing to luminance (whiteness 0.85) threw it away and
gave one flat dim pink. New emission block in `CLOUD_FRAGMENT`:

```glsl
vec3 chroma = emi.r * vec3(1.0, 0.25, 0.85)   // magenta
            + emi.g * vec3(0.55, 0.35, 1.0)   // violet (dominant channel)
            + emi.b * vec3(0.3, 0.65, 1.0);   // cyan
vec3 emiCol = mix(chroma, luminance * color, emissionWhiteness);
final += emiCol * emissionFactor * (1. - type);
```

with `emissionWhiteness 0.35`, `emissionFactor 4.5`.

## 4. The ripple quad was ERASING the disc

`opacity 0.85` on the fullscreen ripple consumer meant: 85% of every pixel
under it was replaced by a fresh copy of the background — wiping 85% of the
disc's filaments. It only needs enough presence for the cursor shimmer:
`opacity: type < 1 ? 1.0 : 0.4`.

## 5. The giant white ellipse — and why "fix the bloom" was the wrong fix

Your build had a huge soft glow swallowing the centre. Killing bloom entirely
did NOT remove it — layer isolation showed it was the background's own core
gaussian (`exp(-16·d²)` at amplitude 1.2). The trap: the composite outputs
sRGB, which LIFTS the darks (linear 0.2 displays as ~0.5), so a wide gaussian
that looks gentle in linear reads as a white ellipse on screen. The glass
only needs a hot SMALL core to disperse; the width should come from bloom:

```glsl
vec2 cv = (vUv - vec2(0.5, 0.5)) * vec2(2.2, 1.1);
col += vec3(0.34, 0.42, 0.95) * exp(-60. * dot(cv, cv));
```

Post retune to match: `threshold 1.05`, `softWidth 0.12`, `bloomPower 0.12`.

## 6. The feather — motion and glass

**Motion** (this alone transforms it — every facet sweeps through the bright
core and the iridescence LUT as it turns):

```ts
featherMesh.rotation.y = seconds * 0.45;
featherMesh.position.y = 0.15 + Math.sin(seconds * 0.6) * 0.05;
```

**Material** (the washed-white look was three stacked settings):
- `fringeMix 0.86 → 0.42` — the white rim was swallowing the silhouette
- `decayFactor 20 → 9` — exp(−20·t) ≈ 0 killed the interior tint entirely
- `reflectionIridescence 0.28 → 0.85` — the rainbow facet sparkle lives here
- `colorFactor 1.45`, `colorCurve 1.1`, `maxColorValue 100 → 5` (100 nukes
  the bloom chain into one white blob the moment anything sparkles)
- `baseColor (0.72, 0.58, 1.0)`, `peaksColor (1.0, 0.75, 1.0)` — violet glass
- `lut.ts` iridescence row: amplitude 0.38 around base 0.62 (was a pastel
  0.25/0.75 — too faint to read as rainbow)

## 7. The beam + "particles in one flame"

Beam: slimmer and hotter — widths `[0.55, 0.32, 0.14]`, `intensity 3.2`,
`falloff 0.5`, `opacity 0.05`. Brightness on slim geometry + bloom = a shaft
with a core, not a wide wash.

Sparks: a second, tighter particle system rising INSIDE the beam column — one
coherent upward current, distinct from the ambient dust. Same DUST shaders,
new geometry + uniforms: 110 points spawned in a 0.16-radius column around
the feather base, `speed 0.8–1.5` all upward, near-zero drift, `lifeTime
2.2`, colour `(0.7, 0.8, 1.12)` (slightly HDR so they twinkle through bloom).
Full code in `main.ts` under "Spark stream".

---

## Files changed
`src/main.ts` (disc, raycast pointer, spawner cam, embers, sparks, beam,
feather motion + material values) · `src/shaders/scene.ts` (cloud vertex/
fragment, background core) · `src/FluidSim.ts` (DYE_STAMP_SCALE) ·
`src/PostChain.ts` (threshold/bloom) · `src/lut.ts` (iridescence row).

## Verified
Headless run, scripted first-move + sweep + settle: no blowups, filament
field covers the disc at idle, chromatic fringing present, feather rotating
with facet sparkle, beam + spark stream coherent. Screenshots attached
(SwiftShader at DPR 1 — on your real GPU at DPR 2 everything is crisper).
