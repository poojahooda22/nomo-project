import './styles.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { FluidSim } from './FluidSim';
import { RippleSim, RIPPLE_SIM_SIZE } from './RippleSim';
import { PostChain } from './PostChain';
import { makeColorsLUT } from './lut';
import { GLASS_BACK_FRAGMENT, GLASS_BACK_VERTEX, GLASS_FRAGMENT, GLASS_VERTEX } from './shaders/glass';
import {
  BEAM_FRAGMENT,
  BEAM_VERTEX,
  BG_FRAGMENT,
  BG_VERTEX,
  CLOUD_FRAGMENT,
  CLOUD_VERTEX,
  DUST_FRAGMENT,
  DUST_VERTEX,
  SPAWNER_FRAGMENT,
  SPAWNER_VERTEX,
  TRAIL_FRAGMENT,
  TRAIL_VERTEX,
} from './shaders/scene';

/**
 * Frame graph, in the captured order:
 *   1. both simulations step (fluid exhales from the feather's silhouette,
 *      ripple hugs the cursor)
 *   2. background layer -> rtA
 *   3. rtA + cloud planes (haze + pink filaments + blue shimmer) -> rtBG
 *   4. rtBG + the glass feather (which refracts rtBG) -> rtFinal
 *   5. post: threshold -> 5-mip bloom -> composite (un-overscan, halo,
 *      PBR Neutral, dither) -> screen
 *   6. cursor trail overlay, straight to screen
 *
 * Everything before step 5 renders with 25% overscan.
 */

const params = new URLSearchParams(location.search);
const LITE = params.has('lite');
const qdpr = Number(params.get('qdpr'));
const DPR = Number.isFinite(qdpr) && qdpr > 0 ? qdpr : LITE ? 0.75 : Math.min(window.devicePixelRatio || 1, 2);
const FLUID_PIXELS = LITE ? 2 ** 16 : 2 ** 18;
/* Injected EVERY frame against dissipation 0.99: steady state is
   injection / 0.01, so 1.6 here meant a plume velocity near 160, a
   permanently over-driven convection cell. These keep the idle plume
   alive but breathing. */
/* Near-silent. The reference's idle hero is CLEAN - a blue gradient, the
   feather, nothing else - so the exhale is kept just strong enough that the
   beam column stays faintly alive, far below filament-forming strength.
   Every visible filament should be one the cursor drew. */
const SPAWN_VELOCITY = 0.022;
const SPAWN_DENSITY = 0.006;

// Layer isolation switches: how the artifacts above were pinned down.
const SHOW = {
  fluidCloud: !params.has('nofluidcloud'),
  rippleCloud: !params.has('noripplecloud'),
  feather: !params.has('nofeather'),
  post: !params.has('nopost'),
  trail: !params.has('notrail'),
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
let rtBack = makeSceneTarget(); // scene + the feather's BACK-face glass pass
let rtFinal = makeSceneTarget();
const spawnerRT = new THREE.WebGLRenderTarget(256, 144, {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
});

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

// The beam: two crossed planes, rotated so the bright core sits at the top
// of frame and the exponential falloff runs DOWN toward the feather.
const beamMat = new THREE.ShaderMaterial({
  vertexShader: BEAM_VERTEX,
  fragmentShader: BEAM_FRAGMENT,
  uniforms: {
    /* Slim, saturated, and DYING before the blade. In the reference the
       beam is a thin bright line from the top of frame that fades out just
       above the feather tip; nothing white ever lies over the blade. Keep
       green under a quarter of blue (sRGB doubles the displayed ratio) and
       let falloff 0.85 extinguish the column before it reaches the glass. */
    color: { value: new THREE.Color(0.10, 0.20, 1.0) },
    intensity: { value: 2.0 },
    falloff: { value: 0.85 },
    opacity: { value: 0.05 },
  },
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const beamGroup = new THREE.Group();
const BEAM_WIDTHS = [0.55, 0.32, 0.14];
for (let i = 0; i < BEAM_WIDTHS.length; i++) {
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(BEAM_WIDTHS[i], 9), beamMat);
  plane.rotation.y = (i * Math.PI) / 3;
  plane.rotation.z = Math.PI; // local +y points down: bright top, fade down
  plane.position.set(0, 3.6, -0.3);
  beamGroup.add(plane);
}
bgScene.add(beamGroup);

// Dust: a single fountain-recycled point cloud, all motion in the vertex shader.
const DUST_COUNT = 320;
const dustGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(DUST_COUNT * 3);
  const birth = new Float32Array(DUST_COUNT);
  const size = new Float32Array(DUST_COUNT);
  const opac = new Float32Array(DUST_COUNT);
  const speed = new Float32Array(DUST_COUNT);
  const drift = new Float32Array(DUST_COUNT * 2);
  let s = 9241;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < DUST_COUNT; i++) {
    pos[i * 3] = (rng() * 2 - 1) * 3.4;
    pos[i * 3 + 1] = -1.6 + rng() * 3.4;
    pos[i * 3 + 2] = -1.2 + rng() * 2.0;
    birth[i] = rng() * 2.5;
    size[i] = rng() * 0.05;
    opac[i] = 0.25 + rng() * 0.75;
    speed[i] = 0.4 + rng() * 1.2;
    drift[i * 2] = (rng() - 0.5) * 0.3;
    drift[i * 2 + 1] = (rng() - 0.5) * 0.3;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  dustGeo.setAttribute('aBirthTime', new THREE.BufferAttribute(birth, 1));
  dustGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  dustGeo.setAttribute('aRandomOpacity', new THREE.BufferAttribute(opac, 1));
  dustGeo.setAttribute('aRandomSpeed', new THREE.BufferAttribute(speed, 1));
  dustGeo.setAttribute('aDrift', new THREE.BufferAttribute(drift, 2));
}
const dustMat = new THREE.ShaderMaterial({
  vertexShader: DUST_VERTEX,
  fragmentShader: DUST_FRAGMENT,
  uniforms: {
    seconds: { value: 0 },
    lifeTime: { value: 2.5 },
    speed: { value: 0.5 },
    baseSize: { value: 0.04 },
    // Ambient dust keeps its straight linear drift, unchanged.
    wanderAmp: { value: 0.0 },
    wanderFreq: { value: 0.0 },
    color: { value: new THREE.Color(0.65, 0.75, 1.0) },
  },
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const dust = new THREE.Points(dustGeo, dustMat);
dust.frustumCulled = false;
bgScene.add(dust);

/* Spark stream: a second, tighter particle system that rises INSIDE the
   beam column — one coherent upward current of bright motes, distinct
   from the ambient drifting dust ("particles moving in one flame"). */
const SPARK_COUNT = 110;
const sparkGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(SPARK_COUNT * 3);
  const birth = new Float32Array(SPARK_COUNT);
  const size = new Float32Array(SPARK_COUNT);
  const opac = new Float32Array(SPARK_COUNT);
  const speed = new Float32Array(SPARK_COUNT);
  const drift = new Float32Array(SPARK_COUNT * 2);
  let s = 5077;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < SPARK_COUNT; i++) {
    const r = Math.sqrt(rng()) * 0.16;      // column radius
    const a = rng() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = -0.6 + rng() * 0.8;    // spawn low, around the feather base
    pos[i * 3 + 2] = -0.3 + Math.sin(a) * r;
    birth[i] = rng() * 2.2;
    size[i] = rng() * 0.05;
    opac[i] = 0.4 + rng() * 0.6;
    speed[i] = 0.8 + rng() * 0.7;           // brisk, all upward: one current
    drift[i * 2] = (rng() - 0.5) * 0.08;    // barely any sideways wander
    drift[i * 2 + 1] = (rng() - 0.5) * 0.08;
  }
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sparkGeo.setAttribute('aBirthTime', new THREE.BufferAttribute(birth, 1));
  sparkGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  sparkGeo.setAttribute('aRandomOpacity', new THREE.BufferAttribute(opac, 1));
  sparkGeo.setAttribute('aRandomSpeed', new THREE.BufferAttribute(speed, 1));
  sparkGeo.setAttribute('aDrift', new THREE.BufferAttribute(drift, 2));
}
const sparkMat = new THREE.ShaderMaterial({
  vertexShader: DUST_VERTEX,
  fragmentShader: DUST_FRAGMENT,
  uniforms: {
    seconds: { value: 0 },
    lifeTime: { value: 2.2 },
    speed: { value: 1.6 },
    baseSize: { value: 0.05 },
    /* The zigzag: roughly two and a half lateral swings over a mote's
       2.2s life, wide enough to read as a wandering path rather than a
       ruled line, tight enough to stay inside the beam column. */
    wanderAmp: { value: 0.16 },
    wanderFreq: { value: 15.0 },
    /* Sub-HDR: at 1.12 the spark motes crossed the bloom threshold and
       smeared a white plume up the beam column, over the blade. */
    color: { value: new THREE.Color(0.30, 0.42, 0.95) },
  },
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const sparks = new THREE.Points(sparkGeo, sparkMat);
sparks.frustumCulled = false;
bgScene.add(sparks);

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
      /* Reference values, read out of its own settings timeline
         (timelines/dev.glb -> Water_emissionXWhitenessType = [5, 0, 0.01],
         Water_color = [255,255,255]): emissionFactor 5, whiteness 0, and a
         WHITE tint. The magenta is the delta texture's own R/B structure,
         so the tint only has to avoid tinting it away. It is nudged a
         little off white here - green pulled down, blue held under red -
         because you asked for more pink and less blue, and that is exactly
         the knob for it: at (1,1,1) the filaments sit at true magenta. */
      color: { value: new THREE.Color(1.0, 0.42, 1.0) },
      emissionFactor: { value: 4.2 },
      /* 0.35 was pushing 35% of every filament toward grey. The reference
         runs 0: full channel separation, which is what makes it read pink. */
      emissionWhiteness: { value: 0.0 },
      interpol: { value: 0.5 },
      /* The reference clamps this slider to 0.1 and this build was at 0.28,
         straight into the blue channel. It is a tinted term now, so the
         value is an intensity and the colour lives in rippleTint. */
      blueness: { value: 0.5 },
      rippleTint: { value: new THREE.Color(1.0, 0.18, 0.62) },
      /* The ripple quad REDRAWS the background over the disc: at 0.85 it
         was erasing 85% of the filaments under it. It only needs enough
         presence for the cursor shimmer. */
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

/* THE CENTER DEAD-ZONE FIX. The fluid goes back to a FULLSCREEN overlay.

   The tilted-disc experiment is what killed the cursor in the middle of the
   page. The disc leaned back at -1.02 rad, so the ray through the CENTER of
   the screen struck it out near its far edge - the region that perspective
   compresses into a few dozen pixels at the horizon. Your center-screen
   swirls were being drawn - into a sliver the size of a matchstick, off
   behind the feather. Only rays through the lower half / sides hit the near
   part of the disc where UV space is roomy, which is exactly the "works at
   the corners, dead in the middle" behaviour you saw.

   The reference never does this. Its Water consumer (class dl in the
   bundle) is a screen quad: one unit of cursor motion is one unit of fluid
   motion everywhere on the page, center included. The receding-ellipse look
   in its hero comes from the cloud IMAGERY, not from tilting the sim.

   Rendered with blitCam (identity matrices), CLOUD_VERTEX degenerates to a
   screen quad with the standard overscan shrink, so vUv == final screen UV
   and the same shader serves both consumers unchanged. renderOrder keeps
   the fluid under the ripple shimmer. */
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

/* ── The feather ───────────────────────────────────────────────────────── */

const featherScene = new THREE.Scene();
let featherMesh: THREE.Mesh | null = null;
let glassMat: THREE.ShaderMaterial | null = null;
let glassBackMat: THREE.ShaderMaterial | null = null;
const spawnerMaterial = new THREE.ShaderMaterial({
  vertexShader: SPAWNER_VERTEX,
  fragmentShader: SPAWNER_FRAGMENT,
});

const texLoader = new THREE.TextureLoader();
const colorsMap = makeColorsLUT();
const noiseMap = texLoader.load('/textures/bluenoise.png');
noiseMap.wrapS = noiseMap.wrapT = THREE.RepeatWrapping;
noiseMap.minFilter = noiseMap.magFilter = THREE.NearestFilter;
const wavesMap = texLoader.load('/textures/waves.jpg');
wavesMap.wrapS = wavesMap.wrapT = THREE.RepeatWrapping;
trailMat.uniforms.noisesMap.value = wavesMap;

new RGBELoader().load('/textures/wooden_studio_19_1k.hdr', (hdr) => {
  hdr.wrapS = THREE.RepeatWrapping;
  if (glassMat) glassMat.uniforms.envMap.value = hdr;
  if (glassBackMat) glassBackMat.uniforms.envMap.value = hdr;
  pendingEnv = hdr;
});
let pendingEnv: THREE.Texture | null = null;

const draco = new DRACOLoader();
draco.setDecoderPath('/draco/');
const gltf = new GLTFLoader();
gltf.setDRACOLoader(draco);
gltf.load('/models/feather.glb', (g) => {
  const source = g.scene.getObjectByProperty('type', 'Mesh') as THREE.Mesh | null;
  if (!source) return;
  const geo = source.geometry as THREE.BufferGeometry;
  geo.center();
  geo.computeBoundingBox();
  const bb = geo.boundingBox as THREE.Box3;
  const height = bb.max.y - bb.min.y;
  const scale = 1.9 / height;

  /* _thickness is authored in model units, but the refraction march happens
     in world space: unscaled, both refraction rays land on the same pixel
     and there is no dispersion at all. Normalise so the thickest point
     pushes the ray ~0.3 world units, whatever the asset's own scale. */
  const thicknessAttr = geo.getAttribute('_thickness') as THREE.BufferAttribute | undefined;
  let maxThickness = 0.1;
  if (thicknessAttr) {
    for (let i = 0; i < thicknessAttr.count; i++) {
      maxThickness = Math.max(maxThickness, thicknessAttr.getX(i));
    }
  }
  const thicknessScale = 0.3 / maxThickness;

  /* Shared uniform values, all from the reference's settings timeline
     (timelines/dev.glb - one Blender empty per uniform, xyz = values):
       Glass_iorVDeltaXshift                  [1.3, 3, 1]
       Glass_colorBoostFactorCurve            [1.55, 1, 0.95]
       Glass_fringeCurveMix                   [4, 0.55, 0]
       Glass_convexConcavePeaks               [0.5, 0.5, 3]
       Glass_reflectionVIri                   [1, 0.2, 0]   (envReflection, reflectionIridescence)
       Glass_refractionVIri                   [0.6, 0.15, 0] (envRefraction, refractionIridescence)
       Glass_colorMaxvalDecayUsetransmittance [50, 20, 1]
       Glass_colorCurveRGB                    [1.15, 1.2, 1.1]
       Glass_distResetX                       [0, 1, 0]
       Glass_color 212,234,255 · Glass_peaksColor 253,208,221 · Glass_fringeColor 243,208,242
     With the two-pass architecture in place these are used AS-IS - no more
     compensating (the 0.85 iridescence / 2.3 env reflection hacks existed
     only because the interior pass was missing). */
  const shared = () => ({
    map: { value: null as THREE.Texture | null },
    envMap: { value: pendingEnv },
    colorsMap: { value: colorsMap },
    noiseMap: { value: noiseMap },
    seconds: { value: 0 },
    iorStart: { value: 1.3 },
    iorDelta: { value: 3.0 },
    useTransmittance: { value: 1 },
    fringeMix: { value: 0.55 },
    fringeCurve: { value: 4.0 },
    fringeColor: { value: new THREE.Color(243 / 255, 208 / 255, 242 / 255) },
    distancesFactor: { value: thicknessScale },
    resetDistances: { value: 1 }, // constant 0.1 world-unit march, both passes
    peaksFactor: { value: 3.0 },
    baseColor: { value: new THREE.Color(212 / 255, 234 / 255, 255 / 255) },
    peaksColor: { value: new THREE.Color(253 / 255, 208 / 255, 221 / 255) },
  });

  /* PASS 1 - the interior. Back faces only, reads rtBG (scene without the
     feather), writes dispersion + refracted warm environment + confetti
     iridescence into rtBack. This pass is where the peach/cyan/pink lives. */
  glassBackMat = new THREE.ShaderMaterial({
    vertexShader: GLASS_BACK_VERTEX,
    fragmentShader: GLASS_BACK_FRAGMENT,
    uniforms: {
      ...shared(),
      uvShiftFactor: { value: 1.0 },
      /* Reference is 0.6 - against ITS backdrop: a scene full of bright varied
         content (sun sprite, crystals, pale Env_background) whose five taps
         differ enough for the spectrum weights to tint each facet. Our hero
         behind the blade is a smooth blue gradient, so the taps come back
         near-identical and the palette normalisation cancels itself. The env
         term substitutes as the bright base...  */
      envRefraction: { value: 1.6 },
      /* ...and the confetti LUT carves that bright base into per-facet hue
         patches (peach / cyan / pink - the multiplier can only subtract, so
         it needs the bright base above to bite into). Reference runs 0.15
         because its tap variance already does most of this. */
      refractionIridescence: { value: 0.55 },
    },
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });

  /* PASS 2 - the front surface, reads rtBack (scene WITH the interior). */
  glassMat = new THREE.ShaderMaterial({
    vertexShader: GLASS_VERTEX,
    fragmentShader: GLASS_FRAGMENT,
    uniforms: {
      ...shared(),
      colorBoost: { value: 1.55 },
      decayFactor: { value: 20 },
      reflectionIridescence: { value: 0.2 },
      colorFactor: { value: 1.0 },
      colorCurve: { value: 0.95 },
      colorCurveR: { value: 1.15 },
      colorCurveG: { value: 1.2 },
      colorCurveB: { value: 1.1 },
      envReflection: { value: 1.0 },
      maxColorValue: { value: 50 },
    },
  });
  featherMesh = new THREE.Mesh(geo, glassMat);
  featherMesh.scale.setScalar(scale);
  featherMesh.position.set(0, 0.15, 0);
  featherMesh.frustumCulled = false;
  featherScene.add(featherMesh);
});

/* ── Pointer ───────────────────────────────────────────────────────────── */

const pointerNow = new THREE.Vector2(0.5, 0.5);

/* Screen space in, screen space out. No raycast, no disc, no overscan
   arithmetic: the fluid UV is the screen UV, so the splat is born exactly
   under the cursor - center of the page included. */
function feedPointer(x: number, y: number): void {
  pointerNow.set(x, y);
  ripple.setPointer(x, y);
  fluid.setPointer(x, y);
}
window.addEventListener('pointermove', (e) => {
  feedPointer(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight);
});

// Cursor ring (DOM), eased in dt so it feels identical at any refresh rate.
const ring = document.querySelector('.cursor-ring') as HTMLElement | null;
const ringPos = new THREE.Vector2(innerWidth / 2, innerHeight / 2);
const ringTarget = new THREE.Vector2(innerWidth / 2, innerHeight / 2);
window.addEventListener('pointermove', (e) => ringTarget.set(e.clientX, e.clientY));

/* ── Intro flourish: a few scripted splats so the fluid is alive before
   the first pointer move (and deterministic under verification). ───────── */

let introT = 0;
const INTRO_SPLATS: [number, number, number, number, number][] = [
  [0.3, 0.42, 0.55, 0.004, 0.003],
  [0.8, 0.62, 0.45, -0.004, 0.002],
  [1.4, 0.5, 0.65, 0.002, -0.003],
  [2.0, 0.38, 0.6, 0.003, 0.002],
];
let nextSplat = 0;

/* The ember churn is GONE. Four invisible emitters were stirring the sim
   every frame, which is why the field never went quiet: the reference's
   hero is completely clean until the cursor moves (its idle frame is just
   the blue gradient and the feather), and every filament on it is one the
   visitor drew. The fluid now has exactly two inputs: the cursor, and the
   feather's own faint exhale. */

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
    for (const rt of [rtA, rtBG, rtBack, rtFinal]) rt.dispose();
    rtA = makeSceneTarget();
    rtBG = makeSceneTarget();
    rtBack = makeSceneTarget();
    rtFinal = makeSceneTarget();
    post.resize(Math.round(w * DPR), Math.round(h * DPR));
  });
});

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

  introT += dt;
  while (nextSplat < INTRO_SPLATS.length && introT > INTRO_SPLATS[nextSplat][0]) {
    const [, x, y, dx, dy] = INTRO_SPLATS[nextSplat++];
    fluid.splatAt(x, y, dx, dy);
  }

  // 1. Spawner silhouette: the feather, flat white, rendered from the MAIN
  //    camera. With the fluid fullscreen again its UV is screen UV, and the
  //    plain (un-overscanned) SPAWNER_VERTEX projection lands the
  //    silhouette exactly where the feather sits on the final screen - the
  //    1.25 shrink at draw time and the 1.25 zoom at composite time cancel.
  let spawnerTex: THREE.Texture | null = null;
  if (featherMesh) {
    const prev = featherMesh.material;
    featherMesh.material = spawnerMaterial;
    renderer.setRenderTarget(spawnerRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(featherScene, camera);
    featherMesh.material = prev;
    spawnerTex = spawnerRT.texture;
  }

  // 2. Simulations. The spawner breathes; the embers stir continuously.
  const breath = 0.7 + 0.3 * Math.sin(seconds * 0.5);
  fluid.step(spawnerTex, SPAWN_VELOCITY * breath * dt * 60, SPAWN_DENSITY * breath * dt * 60);
  ripple.step(seconds);

  // 3. Background -> rtA.
  bgMat.uniforms.seconds.value = seconds;
  dustMat.uniforms.seconds.value = seconds;
  sparkMat.uniforms.seconds.value = seconds;
  renderer.setRenderTarget(rtA);
  renderer.clear(true, true, false);
  renderer.render(bgScene, camera);

  // 4. rtA + clouds -> rtBG.
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

  // 5. rtBG + the feather's BACK-face pass -> rtBack. The interior: five
  //    spectral taps of rtBG plus the warm environment along each refracted
  //    ray, times the confetti iridescence. The front pass then refracts
  //    THIS texture - that layering is the reference's holographic blade.
  if (featherMesh && glassBackMat && SHOW.feather) {
    featherMesh.rotation.y = seconds * 0.45;
    featherMesh.position.y = 0.15 + Math.sin(seconds * 0.6) * 0.05;
  }
  blitMat.uniforms.map.value = rtBG.texture;
  renderer.setRenderTarget(rtBack);
  renderer.clear(true, true, false);
  renderer.render(blitScene, blitCam);
  if (featherMesh && glassBackMat && SHOW.feather) {
    const prev = featherMesh.material;
    featherMesh.material = glassBackMat;
    glassBackMat.uniforms.map.value = rtBG.texture;
    glassBackMat.uniforms.seconds.value = seconds;
    renderer.render(featherScene, camera);
    featherMesh.material = prev;
  }

  // 6. rtBack + the feather's FRONT pass -> rtFinal.
  blitMat.uniforms.map.value = rtBack.texture;
  renderer.setRenderTarget(rtFinal);
  renderer.clear(true, true, false);
  renderer.render(blitScene, blitCam);
  if (featherMesh && glassMat && SHOW.feather) {
    glassMat.uniforms.map.value = rtBack.texture;
    glassMat.uniforms.seconds.value = seconds;
    renderer.render(featherScene, camera);
  }

  // 7. Post to screen, then the trail overlay on top.
  if (SHOW.post) {
    post.render(rtFinal, seconds);
  } else {
    blitMat.uniforms.map.value = rtFinal.texture;
    renderer.setRenderTarget(null);
    renderer.render(blitScene, blitCam);
  }
  if (SHOW.trail) {
    trailMat.uniforms.trailMap.value = ripple.texture;
    trailMat.uniforms.seconds.value = seconds;
    renderer.render(trailScene, blitCam);
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
    feather: !!featherMesh,
    env: !!(glassMat?.uniforms.envMap.value ?? pendingEnv),
    contextAlive: !renderer.getContext().isContextLost(),
  }),
};
