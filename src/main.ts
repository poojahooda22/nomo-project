import './styles.css';
import * as THREE from 'three';
import { FluidSim } from './FluidSim';
import { RippleSim, RIPPLE_SIM_SIZE } from './RippleSim';
import { PostChain } from './PostChain';
import { PageTexture } from './PageTexture';
import {
  BG_FRAGMENT,
  BG_VERTEX,
  CLOUD_FRAGMENT,
  CLOUD_VERTEX,
  TRAIL_FRAGMENT,
  TRAIL_VERTEX,
} from './shaders/scene';

/**
 * Frame graph, in order:
 *   1. both simulations step (fluid and ripple, driven only by the cursor)
 *   2. background -> rtA
 *   3. rtA + the two cloud planes (haze + filaments + cursor shimmer) -> rtBG
 *   4. post: threshold -> 5-mip bloom -> composite (un-overscan, halo,
 *      tonemap, dither) -> screen
 *   5. cursor trail overlay, straight to screen
 *
 * Everything before step 4 renders 25% larger than the frame so the haze and
 * the halo can sample past the visible edge without finding a black border;
 * the composite un-zooms. That un-zoom lives in PostChain, which is why the
 * post step is not optional scenery - bypass it and the whole frame is
 * cropped 25% in.
 */

const params = new URLSearchParams(location.search);
const LITE = params.has('lite');
const qdpr = Number(params.get('qdpr'));
const DPR = Number.isFinite(qdpr) && qdpr > 0 ? qdpr : LITE ? 0.75 : Math.min(window.devicePixelRatio || 1, 2);
const FLUID_PIXELS = LITE ? 2 ** 16 : 2 ** 18;

// Layer isolation switches: how the artifacts in this scene were pinned down.
const SHOW = {
  fluidCloud: !params.has('nofluidcloud'),
  rippleCloud: !params.has('noripplecloud'),
  post: !params.has('nopost'),
  trail: !params.has('notrail'),
  /* The idle drift that keeps the fluid moving with no cursor on it.
     Switchable so the untouched-page behaviour can still be observed. */
  ambient: !params.has('noambient'),
  /* Draws the rasterised page straight to the frame instead of the scene, so
     the raster can be compared against the DOM that produced it. Off by
     default: the DOM is still the visible path and nothing about the
     composite has changed yet. */
  pageTexture: params.has('pagetex'),
};

declare global {
  interface Window {
    __hero?: {
      splat: (x: number, y: number, dx: number, dy: number) => void;
      pointer: (x: number, y: number) => void;
      stats: () => Record<string, number | boolean>;
    };
  }
}

const canvasHost = document.getElementById('gl') as HTMLElement;
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(DPR);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // composite does its own sRGB
renderer.toneMapping = THREE.NoToneMapping;             // composite does its own tonemap
renderer.autoClear = false;
canvasHost.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 60);
camera.position.set(0, 0.1, 4.6);
camera.lookAt(0, 0.1, 0);

/* ── Simulations ───────────────────────────────────────────────────────── */

const fluid = new FluidSim(renderer, FLUID_PIXELS, window.innerWidth / window.innerHeight);
const ripple = new RippleSim(renderer);
ripple.setAspect(window.innerWidth / window.innerHeight);

/* ── Render targets (all at overscan-equivalent full size) ─────────────── */

function makeSceneTarget(): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(
    Math.round(window.innerWidth * DPR),
    Math.round(window.innerHeight * DPR),
    {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    },
  );
}
let rtA = makeSceneTarget();
let rtBG = makeSceneTarget();

const post = new PostChain(renderer);
post.resize(Math.round(window.innerWidth * DPR), Math.round(window.innerHeight * DPR));

/* ── Background layer ──────────────────────────────────────────────────── */

const bgScene = new THREE.Scene();
const bgMat = new THREE.ShaderMaterial({
  vertexShader: BG_VERTEX,
  fragmentShader: BG_FRAGMENT,
  uniforms: { seconds: { value: 0 } },
  depthWrite: false,
  depthTest: false,
});
bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat));

/* ── Cloud planes: the two sim consumers ───────────────────────────────── */

const cloudScene = new THREE.Scene();
function makeCloud(type: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: CLOUD_VERTEX,
    fragmentShader: CLOUD_FRAGMENT,
    uniforms: {
      normalMap: { value: null },
      deltaMap: { value: null },
      map: { value: null },
      simpleMap: { value: null },
      /* The pink is NOT painted on. The fluid normal is built around
         vec3(0,1,0), so the x and z components of its change carry all the
         signal while y stays near zero: R and B lit, G dark, which is
         magenta. This tint only has to avoid tinting that away - at pure
         white the filaments sit at true magenta, and green pulled down with
         blue held under red warms them toward pink. */
      color: { value: new THREE.Color(1.0, 0.42, 1.0) },
      emissionFactor: { value: 4.2 },
      /* Any whiteness here pushes that channel separation back toward grey,
         which is exactly what stops it reading pink. */
      emissionWhiteness: { value: 0.0 },
      interpol: { value: 0.5 },
      /* An intensity, not a colour: the hue lives in rippleTint, so the
         cursor wake belongs to the same palette as the filaments instead of
         adding raw blue. */
      blueness: { value: 0.5 },
      rippleTint: { value: new THREE.Color(1.0, 0.18, 0.62) },
      /* The ripple quad REDRAWS the background over its disc, so a high
         opacity here erases the filaments underneath it. It needs just
         enough presence for the cursor shimmer. */
      opacity: { value: type < 1 ? 1.0 : 0.4 },
      simpleTexel: { value: new THREE.Vector2(1 / RIPPLE_SIM_SIZE, 1 / RIPPLE_SIM_SIZE) },
      // Subtle heat-haze, not a lens blob.
      hazeScale: { value: type < 1 ? 0.02 : 0.03 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
}
const fluidCloudMat = makeCloud(0);
const rippleCloudMat = makeCloud(1);

/* Both consumers are FULLSCREEN quads, and that is what keeps the cursor
   alive in the middle of the page. An earlier build tilted the fluid onto a
   receding 3D disc; the ray through the centre of the screen then struck it
   near its far edge, where perspective compresses UV space into a few dozen
   pixels, so centre-screen swirls were drawn into a sliver. Rendered with
   blitCam (identity matrices) CLOUD_VERTEX degenerates to a screen quad, so
   one unit of cursor motion is one unit of fluid motion everywhere.
   renderOrder keeps the fluid under the ripple shimmer. */
const fluidCloudMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fluidCloudMat);
fluidCloudMesh.renderOrder = 0;
cloudScene.add(fluidCloudMesh);

const rippleCloudMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), rippleCloudMat);
rippleCloudMesh.renderOrder = 1;
cloudScene.add(rippleCloudMesh);

/* ── Blit helper (copy a texture into a target, no overscan) ───────────── */

const blitScene = new THREE.Scene();
const blitMat = new THREE.ShaderMaterial({
  vertexShader: TRAIL_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D map;
    void main() { gl_FragColor = texture2D(map, vUv); }
  `,
  uniforms: { map: { value: null } },
  depthWrite: false,
  depthTest: false,
});
blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat));
const blitCam = new THREE.Camera();

/* ── The page as a texture ─────────────────────────────────────────────── */

/* Built from the DOM, not instead of it. Nothing downstream consumes this
   yet and the display path is unchanged: the browser still paints the text
   and the CSS screen blend still composites the canvas over it. This exists
   so the shaders have the page available to sample, which is the one thing
   they cannot do while the type lives only in the DOM.

   Kept out of the frame loop deliberately. It re-rasters on resize and on
   font load, both of which are layout events, and a per-frame rebuild would
   cost a full Canvas2D repaint plus a texture upload for a surface that has
   not changed. */
const pageRoot = document.querySelector('.page') as HTMLElement | null;
const pageTexture = pageRoot ? new PageTexture({ root: pageRoot, renderer }) : null;

/* ── Cursor trail overlay ──────────────────────────────────────────────── */

const trailScene = new THREE.Scene();
const trailMat = new THREE.ShaderMaterial({
  vertexShader: TRAIL_VERTEX,
  fragmentShader: TRAIL_FRAGMENT,
  uniforms: {
    trailMap: { value: null },
    noisesMap: { value: null },
    seconds: { value: 0 },
    trailColor: { value: new THREE.Color(1.0, 0.14, 0.55) },
  },
  transparent: true,
  depthWrite: false,
  depthTest: false,
});
trailScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), trailMat));

const texLoader = new THREE.TextureLoader();
const wavesMap = texLoader.load('/textures/waves.jpg');
wavesMap.wrapS = wavesMap.wrapT = THREE.RepeatWrapping;
trailMat.uniforms.noisesMap.value = wavesMap;

/* ── Pointer ───────────────────────────────────────────────────────────── */

const pointerNow = new THREE.Vector2(0.5, 0.5);

/* Screen space in, screen space out. No raycast, no disc, no overscan
   arithmetic: the fluid UV is the screen UV, so the splat is born exactly
   under the cursor - centre of the page included. */
/* Stamping the clock in here rather than in the listener means every route
   into the simulation counts as activity, including the scripted pointer the
   verification harness drives. Two call sites setting the same flag is how it
   drifts. */
let lastPointerMs = Number.NEGATIVE_INFINITY;
let pointerInside = false;

function feedPointer(x: number, y: number): void {
  lastPointerMs = performance.now();
  pointerInside = true;
  pointerNow.set(x, y);
  ripple.setPointer(x, y);
  fluid.setPointer(x, y);
}
window.addEventListener('pointermove', (e) => {
  feedPointer(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight);
});
/* Leaving the window hands over immediately instead of waiting out the idle
   timer: the cursor is gone, so there is nothing to defer to. */
window.addEventListener('pointerleave', () => {
  pointerInside = false;
});
window.addEventListener('blur', () => {
  pointerInside = false;
});

// Cursor ring (DOM), eased in dt so it feels identical at any refresh rate.
const ring = document.querySelector('.cursor-ring') as HTMLElement | null;
const ringPos = new THREE.Vector2(innerWidth / 2, innerHeight / 2);
const ringTarget = new THREE.Vector2(innerWidth / 2, innerHeight / 2);
window.addEventListener('pointermove', (e) => ringTarget.set(e.clientX, e.clientY));

/* ── Resize ────────────────────────────────────────────────────────────── */

let resizeQueued = false;
window.addEventListener('resize', () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fluid.resize(FLUID_PIXELS, w / h);
    ripple.setAspect(w / h);
    for (const rt of [rtA, rtBG]) rt.dispose();
    rtA = makeSceneTarget();
    rtBG = makeSceneTarget();
    post.resize(Math.round(w * DPR), Math.round(h * DPR));
    /* After the render targets, so the re-raster measures a DOM that has
       already been laid out at the new size. Measuring first would bake the
       old grid into the texture. */
    pageTexture?.resize();
  });
});

/* ── Ambient drift ─────────────────────────────────────────────────────── */

/*
  Keeps the fluid alive when nobody is touching it.

  It drives `fluid.setPointer`, the same entry the real cursor uses, rather
  than injecting through `splatAt`. That is the whole trick: the ambient
  motion is not a second effect that has to be tuned to resemble the first,
  it IS the first, moved by an invisible hand. Anything tuned about the
  cursor's feel is inherited for free and cannot drift out of sync with it.

  Handing over is the part that needs care. `doSplat` clamps the velocity it
  injects, but it still stamps the splat ALONG the segment from the previous
  point to the current one, so a jump between the drift path and a real
  cursor sitting elsewhere paints a streak right across the frame even though
  the impulse itself is capped. The fix costs one line: on a handover, feed
  the new position twice. The first call leaves prev pointing at the old
  source, the second overwrites prev with the new position, the measured
  delta collapses to zero, and the frame that would have drawn the streak
  draws nothing at all.
*/

/** Quiet time before the drift takes over, in ms. */
const AMBIENT_IDLE_MS = 1400;

/*
  Peak speed of the invisible hand, in path-radians per ms.

  The splat strength is proportional to how far the pointer travelled since
  the last frame, so this number is an intensity control, not just a tempo.
  It was first set at 0.0004, which works out to a per-frame delta of about
  0.003 - and the constant at the top of FluidSim records a real, deliberate
  cursor flick as 0.0034. The page was therefore flicking itself at nearly
  full strength sixty times a second, and inside ten seconds the frame was a
  solid sheet of dye with no black left in it.
*/
const AMBIENT_RATE = 0.00026;

/*
  Strokes, not a drag.

  A hand moving at a constant rate has no resting point: it deposits dye
  every frame, dissipation never catches up, and the field climbs until it
  saturates. Gating the speed behind a slow envelope gives the solver long
  stretches to settle in, so the field finds an equilibrium well under
  saturation instead of running away.

  Cubed rather than raw, because a plain sine spends half its time near full
  speed. Cubing pushes the mean down to a third while leaving the peaks
  intact, which turns a continuous drag into occasional strokes with rests
  between them - much closer to how somebody actually moves a cursor.
*/
const AMBIENT_ENVELOPE_RATE = 0.00035;

/* Four incommensurate frequencies, so the path never closes on itself. A
   single sine reads as a pendulum within about two passes; layering a second
   term at a non-integer multiple pushes the true period out past any time
   anyone spends on the page. */
function ambientAt(phase: number): { x: number; y: number } {
  return {
    x: 0.5 + 0.3 * Math.sin(phase) + 0.08 * Math.sin(phase * 2.3 + 1.1),
    y: 0.5 + 0.2 * Math.cos(phase * 1.37) + 0.06 * Math.cos(phase * 3.1 + 0.6),
  };
}

let ambientRunning = false;
/* Advanced by the envelope rather than read off the clock, so the pauses are
   real pauses in the path and not just a quieter push along it. */
let ambientPhase = 0;
let ambientPrevMs = 0;

function driveAmbient(nowMs: number): void {
  if (!SHOW.ambient) return;

  const idle = !pointerInside || nowMs - lastPointerMs > AMBIENT_IDLE_MS;

  if (!idle) {
    if (ambientRunning) {
      ambientRunning = false;
      /* Swallow the handover, or the fluid streaks from wherever the drift
         had wandered back to the real cursor. */
      fluid.setPointer(pointerNow.x, pointerNow.y);
      fluid.setPointer(pointerNow.x, pointerNow.y);
    }
    return;
  }

  /* Clamped: a backgrounded tab returns with a huge gap, and an unclamped
     step would advance the phase far enough to teleport the hand. */
  const dt = ambientPrevMs === 0 ? 16 : Math.min(nowMs - ambientPrevMs, 50);
  ambientPrevMs = nowMs;

  const swell = 0.5 + 0.5 * Math.sin(nowMs * AMBIENT_ENVELOPE_RATE);
  ambientPhase += dt * AMBIENT_RATE * swell * swell * swell;

  const p = ambientAt(ambientPhase);
  if (!ambientRunning) {
    ambientRunning = true;
    fluid.setPointer(p.x, p.y);
  }
  fluid.setPointer(p.x, p.y);
}

/* ── Frame loop ────────────────────────────────────────────────────────── */

const clock = new THREE.Clock();
let paused = false;
document.addEventListener('visibilitychange', () => {
  paused = document.hidden;
});

function frame(): void {
  requestAnimationFrame(frame);
  if (paused) return;
  const dt = Math.min(clock.getDelta(), 0.1);
  const seconds = clock.elapsedTime;

  /* 1. Simulations. Nothing injects into the fluid but the pointer: there is
        no emitter breathing into it, so an untouched page stays completely
        still and every filament on screen is one the visitor drew. */
  driveAmbient(performance.now());
  fluid.step(null, 0, 0);
  ripple.step(seconds);

  // 2. Background -> rtA.
  bgMat.uniforms.seconds.value = seconds;
  renderer.setRenderTarget(rtA);
  renderer.clear(true, true, false);
  renderer.render(bgScene, camera);

  // 3. rtA + clouds -> rtBG.
  blitMat.uniforms.map.value = rtA.texture;
  renderer.setRenderTarget(rtBG);
  renderer.clear(true, true, false);
  renderer.render(blitScene, blitCam);
  fluidCloudMat.uniforms.normalMap.value = fluid.normalTexture;
  fluidCloudMat.uniforms.deltaMap.value = fluid.deltaTexture;
  fluidCloudMat.uniforms.map.value = rtA.texture;
  rippleCloudMat.uniforms.simpleMap.value = ripple.texture;
  rippleCloudMat.uniforms.map.value = rtA.texture;
  fluidCloudMesh.visible = SHOW.fluidCloud;
  rippleCloudMesh.visible = SHOW.rippleCloud;
  renderer.render(cloudScene, blitCam); // fluid + ripple, both screen-space

  // 4. Post to screen, then the trail overlay on top.
  if (SHOW.post) {
    post.render(rtBG, seconds);
  } else {
    blitMat.uniforms.map.value = rtBG.texture;
    renderer.setRenderTarget(null);
    renderer.render(blitScene, blitCam);
  }
  if (SHOW.trail) {
    trailMat.uniforms.trailMap.value = ripple.texture;
    trailMat.uniforms.seconds.value = seconds;
    renderer.render(trailScene, blitCam);
  }

  /* Verification only. A raw blit with no colour conversion at either end:
     the texture is untagged and the renderer outputs linear, so the sRGB
     bytes Canvas2D wrote reach the screen unchanged. That makes the result
     directly comparable to a screenshot of the DOM. */
  if (SHOW.pageTexture && pageTexture) {
    blitMat.uniforms.map.value = pageTexture.texture;
    renderer.setRenderTarget(null);
    renderer.render(blitScene, blitCam);
  }

  // Cursor ring easing.
  if (ring) {
    const k = 1 - Math.exp(-10 * dt);
    ringPos.lerp(ringTarget, k);
    ring.style.transform = `translate(${ringPos.x - 24}px, ${ringPos.y - 24}px)`;
  }
}
frame();

window.__hero = {
  splat: (x, y, dx, dy) => fluid.splatAt(x, y, dx, dy),
  // Scripted pointer path for the verification harness: exactly what a
  // real pointermove feeds, including the first-event edge case.
  pointer: (x, y) => feedPointer(x, y),
  stats: () => ({
    dpr: DPR,
    fluidPixels: FLUID_PIXELS,
    contextAlive: !renderer.getContext().isContextLost(),
  }),
};
