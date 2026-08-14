import './styles.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { FluidSim } from './FluidSim';
import { RippleSim, RIPPLE_SIM_SIZE } from './RippleSim';
import { PostChain } from './PostChain';
import { makeColorsLUT } from './lut';
import { GLASS_FRAGMENT, GLASS_VERTEX } from './shaders/glass';
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
const SPAWN_VELOCITY = 0.07;
const SPAWN_DENSITY = 0.024;

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
    /* Deep saturated blue at moderate intensity. At 3.2 the layered
       planes stacked past 1.0 where the tonemapper desaturates toward
       white; the reference beam stays blue along its whole length. */
    color: { value: new THREE.Color(0.3, 0.42, 1.0) },
    intensity: { value: 2.4 },
    falloff: { value: 0.5 },
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
    color: { value: new THREE.Color(0.7, 0.8, 1.12) },
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
      emissionFactor: { value: 3.4 },
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

/* The fluid no longer lives on a fullscreen overlay. It is a big TILTED
   DISC in the 3D scene, rendered with the main camera — that perspective
   is what makes the filaments read as the reference's receding ellipse
   around the feather instead of flat wallpaper. The ripple consumer stays
   fullscreen: it is a screen-space cursor shimmer by nature. */
const discScene = new THREE.Scene();
const fluidDisc = new THREE.Mesh(new THREE.PlaneGeometry(11, 8), fluidCloudMat);
fluidDisc.rotation.x = -1.02; // leaning back: floor-like, elliptical in view
fluidDisc.position.set(0, -0.2, -0.4);
fluidDisc.frustumCulled = false;
discScene.add(fluidDisc);

const rippleCloudMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), rippleCloudMat);
rippleCloudMesh.renderOrder = 1;
cloudScene.add(rippleCloudMesh);

/* Spawner camera: an orthographic camera PARENTED TO THE DISC, looking
   straight down the disc's normal with a frustum equal to the disc's own
   half-extents. Its render is therefore pixel-aligned with the disc's UV
   space — exactly what the FluidSpawner pass needs. (The old version
   rendered from the main camera, which only matched a fullscreen fluid.) */
const spawnerCam = new THREE.OrthographicCamera(-5.5, 5.5, 4, -4, 0.1, 12);
spawnerCam.position.set(0, 0, 6);
fluidDisc.add(spawnerCam);

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

  glassMat = new THREE.ShaderMaterial({
    vertexShader: GLASS_VERTEX,
    fragmentShader: GLASS_FRAGMENT,
    uniforms: {
      map: { value: null },
      envMap: { value: pendingEnv },
      colorsMap: { value: colorsMap },
      noiseMap: { value: noiseMap },
      seconds: { value: 0 },
      /* Everything below is lifted from the reference's own settings
         timeline (timelines/dev.glb), where each uniform is stored as an
         empty's xyz. No more guessing:
           Glass_iorVDeltaXshift                  [1.3, 3, 1]
           Glass_colorBoostFactorCurve            [1.55, 1, 0.95]
           Glass_fringeCurveMix                   [4, 0.55, 0]
           Glass_convexConcavePeaks               [0.5, 0.5, 3]
           Glass_reflectionVIri                   [1, 0.2, 0]
           Glass_colorMaxvalDecayUsetransmittance [50, 20, 1]
           Glass_colorCurveRGB                    [1.15, 1.2, 1.1]
           Glass_distResetX                       [0, 1, 0]
           Glass_color      212,234,255   Glass_peaksColor 253,208,221
           Glass_fringeColor 243,208,242
         The big one is iorDelta 3.0 (this build had 0.909). That is what
         spreads the five refraction taps far enough apart to actually
         disperse - at 0.909 all five landed on nearly the same texel, so
         the feather could only ever be the colour of whatever was behind
         it, which is why it came out a single flat blue crystal. */
      iorStart: { value: 1.3 },
      iorDelta: { value: 3.0 },
      uvShiftFactor: { value: 1.0 },
      useTransmittance: { value: 1 },
      fringeMix: { value: 0.55 },
      fringeCurve: { value: 4.0 },
      fringeColor: { value: new THREE.Color(243 / 255, 208 / 255, 242 / 255) },
      colorBoost: { value: 1.55 },
      decayFactor: { value: 20 },
      /* Reference value is 0.2. Pushed up because this build has no second
         refraction-iridescence term (Glass_refractionVIri = [0.6, 0.15])
         to carry facet colour, so all of it has to ride on the reflection. */
      reflectionIridescence: { value: 0.55 },
      colorFactor: { value: 1.25 },
      colorCurve: { value: 0.95 },
      colorCurveR: { value: 1.15 },
      colorCurveG: { value: 1.2 },
      colorCurveB: { value: 1.1 },
      envReflection: { value: 1.5 },
      maxColorValue: { value: 50 },
      /* Glass_distResetX = [0, 1, 0]: the reference runs resetDistances 1,
         i.e. a CONSTANT thickness of 0.1 world units rather than the baked
         per-vertex attribute. decayFactor 20 is calibrated against that
         0.1 - exp(-0.1*20) = 0.135, so the glass tint survives instead of
         being annihilated the way it was with a 0.3-scaled thickness. */
      distancesFactor: { value: thicknessScale },
      resetDistances: { value: 1 },
      peaksFactor: { value: 3.0 },
      baseColor: { value: new THREE.Color(212 / 255, 234 / 255, 255 / 255) },
      peaksColor: { value: new THREE.Color(253 / 255, 208 / 255, 221 / 255) },
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
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/* The fluid's UV space is the DISC's UV space now, so the cursor must be
   raycast onto the disc. One subtlety: the scene renders with 25% overscan
   (clip.xy /= 1.25) and the composite zooms back in, so a visible screen
   point corresponds to NDC * 1.25 in raw camera space. */
function feedPointer(x: number, y: number): void {
  pointerNow.set(x, y);
  ripple.setPointer(x, y); // ripple stays screen-space
  ndc.set((x * 2 - 1) * 1.25, (y * 2 - 1) * 1.25);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(fluidDisc, false)[0];
  if (hit && hit.uv) fluid.setPointer(hit.uv.x, hit.uv.y);
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

/* Ember churn: the reference's disc is COVERED in filaments even when the
   mouse is idle, because the scene keeps stirring its own fluid. Three
   invisible emitters orbit the disc centre on incommensurate periods and
   drag capsule splats behind them every frame — a continuous, non-repeating
   stir that keeps the whole disc etched. (In disc-UV space; impulses run
   through the same MAX_IMPULSE cap as the mouse.) */
const EMBERS = [
  /* Two INNER embers orbit tight and fast around the disc centre, so the
     region under the feather churns as strongly at idle as the outer
     field does - previously nothing stirred inside r 0.13 and the centre
     only lit up when the mouse crossed it. Higher angular speed keeps
     their linear speed (and so their splat strength) comparable to the
     wide slow orbits. */
  { r: 0.05, rv: 0.8, w: 0.9, p: 3.3 },
  { r: 0.09, rv: 0.7, w: -0.7, p: 5.0 },
  { r: 0.16, rv: 0.6, w: 0.5, p: 0.0 },
  { r: 0.24, rv: 0.55, w: -0.37, p: 2.1 },
  { r: 0.33, rv: 0.5, w: 0.26, p: 4.4 },
  { r: 0.42, rv: 0.45, w: -0.19, p: 1.2 },
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
      const dx = x - prev.x;
      const dy = y - prev.y;
      if (Math.hypot(dx, dy) > 1e-5) fluid.splatAt(x, y, dx, dy);
    }
    prev.set(x, y);
  }
}

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
    for (const rt of [rtA, rtBG, rtFinal]) rt.dispose();
    rtA = makeSceneTarget();
    rtBG = makeSceneTarget();
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

  // 1. Spawner silhouette: the feather, flat white, rendered from the
  //    disc-aligned ortho camera so the footprint lands in disc-UV space.
  let spawnerTex: THREE.Texture | null = null;
  if (featherMesh) {
    const prev = featherMesh.material;
    featherMesh.material = spawnerMaterial;
    renderer.setRenderTarget(spawnerRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(featherScene, spawnerCam);
    featherMesh.material = prev;
    spawnerTex = spawnerRT.texture;
  }

  // 2. Simulations. The spawner breathes; the embers stir continuously.
  stirEmbers(seconds);
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
  fluidDisc.visible = SHOW.fluidCloud;
  rippleCloudMesh.visible = SHOW.rippleCloud;
  renderer.render(discScene, camera);   // the tilted disc, in perspective
  renderer.render(cloudScene, blitCam); // the fullscreen ripple shimmer

  // 5. rtBG + feather -> rtFinal.
  blitMat.uniforms.map.value = rtBG.texture;
  renderer.setRenderTarget(rtFinal);
  renderer.clear(true, true, false);
  renderer.render(blitScene, blitCam);
  if (featherMesh && glassMat && SHOW.feather) {
    /* The reference feather is never still: a slow continuous turn plus a
       breathing bob. The turn is what makes the dispersion and env
       reflection LIVE — every facet sweeps through the bright core and the
       iridescence LUT as it rotates. */
    featherMesh.rotation.y = seconds * 0.45;
    featherMesh.position.y = 0.15 + Math.sin(seconds * 0.6) * 0.05;
    glassMat.uniforms.map.value = rtBG.texture;
    glassMat.uniforms.seconds.value = seconds;
    renderer.render(featherScene, camera);
  }

  // 6. Post to screen, then the trail overlay on top.
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
