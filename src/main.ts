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
const SPAWN_VELOCITY = 0.05;
const SPAWN_DENSITY = 0.012;

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
    color: { value: new THREE.Color(0.4, 0.5, 1.0) },
    intensity: { value: 2.8 },
    falloff: { value: 0.32 },
    opacity: { value: 0.06 },
  },
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const beamGroup = new THREE.Group();
for (let i = 0; i < 3; i++) {
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.9 - i * 0.25, 9), beamMat);
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
      /* The delta texture's channels are normal-component differences,
         not colours; shown raw they skew green-yellow. High whiteness
         collapses them to luminance FIRST so the pink tint shows, and
         factor 6 blooms without clipping to white. */
      color: { value: new THREE.Color(1.0, 0.28, 0.75) },
      emissionFactor: { value: 6.0 },
      emissionWhiteness: { value: 0.85 },
      interpol: { value: 0.5 },
      type: { value: type },
      blueness: { value: 0.28 },
      opacity: { value: type < 1 ? 1.0 : 0.85 },
      simpleTexel: { value: new THREE.Vector2(1 / RIPPLE_SIM_SIZE, 1 / RIPPLE_SIM_SIZE) },
      // Subtle heat-haze, not a lens blob.
      hazeScale: { value: type < 1 ? 0.02 : 0.05 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
}
const fluidCloudMat = makeCloud(0);
const rippleCloudMat = makeCloud(1);
cloudScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fluidCloudMat));
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
      iorStart: { value: 1.214 },
      iorDelta: { value: 0.909 },
      uvShiftFactor: { value: 2.11 },
      useTransmittance: { value: 1 },
      fringeMix: { value: 0.86 },
      fringeCurve: { value: 4.08 },
      fringeColor: { value: new THREE.Color(0.95, 0.97, 1.0) },
      colorBoost: { value: 2 },
      decayFactor: { value: 20 },
      reflectionIridescence: { value: 0.28 },
      colorFactor: { value: 2 },
      colorCurve: { value: 1.34 },
      colorCurveR: { value: 1 },
      colorCurveG: { value: 1 },
      colorCurveB: { value: 1 },
      envReflection: { value: 1.6 },
      maxColorValue: { value: 100 },
      distancesFactor: { value: thicknessScale },
      resetDistances: { value: 0 },
      peaksFactor: { value: 2.45 },
      baseColor: { value: new THREE.Color(0.85, 0.78, 1.0) },
      peaksColor: { value: new THREE.Color(1.0, 0.85, 1.0) },
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
window.addEventListener('pointermove', (e) => {
  const x = e.clientX / window.innerWidth;
  const y = 1 - e.clientY / window.innerHeight;
  pointerNow.set(x, y);
  fluid.setPointer(x, y);
  ripple.setPointer(x, y);
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

  // 1. Spawner silhouette: the feather, flat white, from the main camera.
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

  // 2. Simulations. The spawner breathes on a slow cycle instead of
  //    injecting a constant stream.
  const breath = 0.7 + 0.3 * Math.sin(seconds * 0.5);
  fluid.step(spawnerTex, SPAWN_VELOCITY * breath * dt * 60, SPAWN_DENSITY * breath * dt * 60);
  ripple.step(seconds);

  // 3. Background -> rtA.
  bgMat.uniforms.seconds.value = seconds;
  dustMat.uniforms.seconds.value = seconds;
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
  fluidCloudMat.visible = SHOW.fluidCloud;
  rippleCloudMesh.visible = SHOW.rippleCloud;
  renderer.render(cloudScene, blitCam);

  // 5. rtBG + feather -> rtFinal.
  blitMat.uniforms.map.value = rtBG.texture;
  renderer.setRenderTarget(rtFinal);
  renderer.clear(true, true, false);
  renderer.render(blitScene, blitCam);
  if (featherMesh && glassMat && SHOW.feather) {
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
  pointer: (x, y) => {
    pointerNow.set(x, y);
    fluid.setPointer(x, y);
    ripple.setPointer(x, y);
  },
  stats: () => ({
    dpr: DPR,
    fluidPixels: FLUID_PIXELS,
    feather: !!featherMesh,
    env: !!(glassMat?.uniforms.envMap.value ?? pendingEnv),
    contextAlive: !renderer.getContext().isContextLost(),
  }),
};
