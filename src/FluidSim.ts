import * as THREE from 'three';
import {
  FLUID_ADVECTION,
  FLUID_CLEAR,
  FLUID_CURL,
  FLUID_DIVERGENCE,
  FLUID_GRADIENT_SUBTRACT,
  FLUID_NORMAL,
  FLUID_NORMAL_DELTA,
  FLUID_PRESSURE,
  FLUID_SPAWNER,
  FLUID_SPLAT,
  FLUID_VERTEX,
  FLUID_VORTICITY,
} from './shaders/fluid';

/**
 * The solver orchestration. Per frame, in the exact captured order:
 * spawner injection -> pointer splat -> curl -> vorticity -> divergence ->
 * pressure decay -> 2 Jacobi iterations -> gradient subtract -> advect
 * velocity -> advect dye -> normal -> normal-delta.
 *
 * Velocity ping-pongs at sim resolution; dye at twice that (fine filaments
 * need the pixels, the physics does not).
 */

const PRESSURE_ITERATIONS = 2;
const VELOCITY_DISSIPATION = 0.99;
const DENSITY_DISSIPATION = 0.955;
const PRESSURE_DECAY = 0.99;
const CURL_STRENGTH = 10;
const SPLAT_RADIUS = 0.0015;
const NORMAL_EPSILON = 0.005;
const DS = 1 / 60;
/* Caps the per-event pointer delta before the 1e4 amplification: batched
   pointer events or a frame hiccup must never inject velocity in the
   hundreds.
   The captured reference splat colour for a real downward flick was
   [0, -33.9, 1], i.e. a delta near 0.0034; this ceiling sits just above
   that so a deliberate flick is strong and nothing else can run away. */
const MAX_IMPULSE = 0.006;
/* The dye takes a fraction of the impulse. At full strength the dye field
   clips for seconds, and a clipped interior is FLAT - the edge detector
   then finds nothing but the outer border, drawing one fat blob instead
   of wire-thin filaments. */
const DYE_STAMP_SCALE = 0.3;

interface PingPong {
  read: THREE.WebGLRenderTarget;
  write: THREE.WebGLRenderTarget;
  swap(): void;
}

function makePingPong(w: number, h: number): PingPong {
  const opts: THREE.RenderTargetOptions = {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
  };
  const pair = {
    read: new THREE.WebGLRenderTarget(w, h, opts),
    write: new THREE.WebGLRenderTarget(w, h, opts),
    swap() {
      const t = pair.read;
      pair.read = pair.write;
      pair.write = t;
    },
  };
  return pair;
}

function makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
}

export class FluidSim {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private quad: THREE.Mesh;
  private mats: Record<string, THREE.RawShaderMaterial> = {};

  private velocity!: PingPong;
  private density!: PingPong;
  private pressure!: PingPong;
  private curlRT!: THREE.WebGLRenderTarget;
  private divergenceRT!: THREE.WebGLRenderTarget;
  private normalRT!: THREE.WebGLRenderTarget;
  private normalDeltaRT!: THREE.WebGLRenderTarget;

  private simW = 0;
  private simH = 0;
  private pointer = new THREE.Vector2(-1, -1);
  private prevPointer = new THREE.Vector2(-1, -1);
  private pointerMoved = false;

  constructor(renderer: THREE.WebGLRenderer, targetPixels: number, aspect: number) {
    this.renderer = renderer;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.scene.add(this.quad);

    const defs: [string, string][] = [
      ['clear', FLUID_CLEAR],
      ['splat', FLUID_SPLAT],
      ['spawner', FLUID_SPAWNER],
      ['advection', FLUID_ADVECTION],
      ['divergence', FLUID_DIVERGENCE],
      ['curl', FLUID_CURL],
      ['vorticity', FLUID_VORTICITY],
      ['pressure', FLUID_PRESSURE],
      ['gradSub', FLUID_GRADIENT_SUBTRACT],
      ['normal', FLUID_NORMAL],
      ['normalDelta', FLUID_NORMAL_DELTA],
    ];
    for (const [name, frag] of defs) {
      this.mats[name] = new THREE.RawShaderMaterial({
        vertexShader: FLUID_VERTEX,
        fragmentShader: frag,
        uniforms: { texelSize: { value: new THREE.Vector2() } },
        depthTest: false,
        depthWrite: false,
      });
    }
    // Uniform sets differ per pass; declared here once, mutated per frame.
    Object.assign(this.mats.clear.uniforms, { baseMap: { value: null }, value: { value: PRESSURE_DECAY } });
    Object.assign(this.mats.splat.uniforms, {
      baseMap: { value: null },
      aspectRatio: { value: 1 },
      color: { value: new THREE.Vector3() },
      point: { value: new THREE.Vector2() },
      prevPoint: { value: new THREE.Vector2() },
      radius: { value: SPLAT_RADIUS },
    });
    Object.assign(this.mats.spawner.uniforms, {
      spawner: { value: null },
      baseMap: { value: null },
      amplification: { value: 0 },
    });
    Object.assign(this.mats.advection.uniforms, {
      uVelocity: { value: null },
      uSource: { value: null },
      velTexelSize: { value: new THREE.Vector2() },
      ds: { value: DS },
      dissipation: { value: 1 },
    });
    Object.assign(this.mats.divergence.uniforms, { uVelocity: { value: null } });
    Object.assign(this.mats.curl.uniforms, { uVelocity: { value: null } });
    Object.assign(this.mats.vorticity.uniforms, {
      uVelocity: { value: null },
      uCurl: { value: null },
      curl: { value: CURL_STRENGTH },
      ds: { value: DS },
    });
    Object.assign(this.mats.pressure.uniforms, { uPressure: { value: null }, uDivergence: { value: null } });
    Object.assign(this.mats.gradSub.uniforms, { uPressure: { value: null }, uVelocity: { value: null } });
    Object.assign(this.mats.normal.uniforms, { uDensity: { value: null }, normalEpsilon: { value: NORMAL_EPSILON } });
    Object.assign(this.mats.normalDelta.uniforms, { uNormal: { value: null } });

    this.resize(targetPixels, aspect);
  }

  /** Grid sized to a pixel budget at the screen aspect. */
  resize(targetPixels: number, aspect: number): void {
    const h = Math.round(Math.sqrt(targetPixels / aspect));
    const w = Math.round(h * aspect);
    if (w === this.simW && h === this.simH) return;
    this.simW = w;
    this.simH = h;
    this.disposeTargets();
    this.velocity = makePingPong(w, h);
    this.pressure = makePingPong(w, h);
    this.density = makePingPong(w * 2, h * 2);
    this.curlRT = makeTarget(w, h);
    this.divergenceRT = makeTarget(w, h);
    this.normalRT = makeTarget(w * 2, h * 2);
    this.normalDeltaRT = makeTarget(w * 2, h * 2);
  }

  get normalTexture(): THREE.Texture {
    return this.normalRT.texture;
  }

  get deltaTexture(): THREE.Texture {
    return this.normalDeltaRT.texture;
  }

  setPointer(x: number, y: number): void {
    this.prevPointer.copy(this.pointer);
    this.pointer.set(x, y);
    if (this.prevPointer.x < 0) this.prevPointer.copy(this.pointer);
    this.pointerMoved = this.pointer.distanceToSquared(this.prevPointer) > 1e-8;
  }

  /** Scripted splat for the verification harness and intro flourishes. */
  splatAt(x: number, y: number, dx: number, dy: number): void {
    this.doSplat(new THREE.Vector2(x - dx, y - dy), new THREE.Vector2(x, y), dx, dy);
  }

  private doSplat(prev: THREE.Vector2, point: THREE.Vector2, dx: number, dy: number): void {
    const len = Math.hypot(dx, dy);
    if (len > MAX_IMPULSE) {
      const k = MAX_IMPULSE / len;
      dx *= k;
      dy *= k;
    }
    const m = this.mats.splat;
    m.uniforms.aspectRatio.value = this.simW / this.simH;
    (m.uniforms.point.value as THREE.Vector2).copy(point);
    (m.uniforms.prevPoint.value as THREE.Vector2).copy(prev);
    // The mouse velocity itself is the splat colour: (dx, dy, 1) * 1e4.
    (m.uniforms.color.value as THREE.Vector3).set(dx * 1e4, dy * 1e4, 1);
    m.uniforms.baseMap.value = this.velocity.read.texture;
    this.blit(m, this.velocity.write, this.simW, this.simH);
    this.velocity.swap();
    (m.uniforms.color.value as THREE.Vector3).set(
      dx * 1e4 * DYE_STAMP_SCALE,
      dy * 1e4 * DYE_STAMP_SCALE,
      1,
    );
    m.uniforms.baseMap.value = this.density.read.texture;
    this.blit(m, this.density.write, this.simW * 2, this.simH * 2);
    this.density.swap();
  }

  /** One full solver step. spawnerTex may be null when nothing is burning. */
  step(spawnerTex: THREE.Texture | null, spawnVelocity: number, spawnDensity: number): void {
    const w = this.simW;
    const h = this.simH;

    if (spawnerTex) {
      const m = this.mats.spawner;
      m.uniforms.spawner.value = spawnerTex;
      m.uniforms.amplification.value = spawnVelocity;
      m.uniforms.baseMap.value = this.velocity.read.texture;
      this.blit(m, this.velocity.write, w, h);
      this.velocity.swap();
      m.uniforms.amplification.value = spawnDensity;
      m.uniforms.baseMap.value = this.density.read.texture;
      this.blit(m, this.density.write, w * 2, h * 2);
      this.density.swap();
    }

    if (this.pointerMoved) {
      const d = new THREE.Vector2().subVectors(this.pointer, this.prevPointer);
      this.doSplat(this.prevPointer, this.pointer, d.x, d.y);
      this.pointerMoved = false;
    }

    this.mats.curl.uniforms.uVelocity.value = this.velocity.read.texture;
    this.blit(this.mats.curl, this.curlRT, w, h);

    this.mats.vorticity.uniforms.uVelocity.value = this.velocity.read.texture;
    this.mats.vorticity.uniforms.uCurl.value = this.curlRT.texture;
    this.blit(this.mats.vorticity, this.velocity.write, w, h);
    this.velocity.swap();

    this.mats.divergence.uniforms.uVelocity.value = this.velocity.read.texture;
    this.blit(this.mats.divergence, this.divergenceRT, w, h);

    this.mats.clear.uniforms.baseMap.value = this.pressure.read.texture;
    this.blit(this.mats.clear, this.pressure.write, w, h);
    this.pressure.swap();

    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      this.mats.pressure.uniforms.uPressure.value = this.pressure.read.texture;
      this.mats.pressure.uniforms.uDivergence.value = this.divergenceRT.texture;
      this.blit(this.mats.pressure, this.pressure.write, w, h);
      this.pressure.swap();
    }

    this.mats.gradSub.uniforms.uPressure.value = this.pressure.read.texture;
    this.mats.gradSub.uniforms.uVelocity.value = this.velocity.read.texture;
    this.blit(this.mats.gradSub, this.velocity.write, w, h);
    this.velocity.swap();

    const adv = this.mats.advection;
    (adv.uniforms.velTexelSize.value as THREE.Vector2).set(1 / w, 1 / h);
    adv.uniforms.uVelocity.value = this.velocity.read.texture;
    adv.uniforms.uSource.value = this.velocity.read.texture;
    adv.uniforms.dissipation.value = VELOCITY_DISSIPATION;
    this.blit(adv, this.velocity.write, w, h);
    this.velocity.swap();

    adv.uniforms.uVelocity.value = this.velocity.read.texture;
    adv.uniforms.uSource.value = this.density.read.texture;
    adv.uniforms.dissipation.value = DENSITY_DISSIPATION;
    this.blit(adv, this.density.write, w * 2, h * 2);
    this.density.swap();

    this.mats.normal.uniforms.uDensity.value = this.density.read.texture;
    this.blit(this.mats.normal, this.normalRT, w * 2, h * 2);

    this.mats.normalDelta.uniforms.uNormal.value = this.normalRT.texture;
    this.blit(this.mats.normalDelta, this.normalDeltaRT, w * 2, h * 2);
  }

  private blit(material: THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget, w: number, h: number): void {
    (material.uniforms.texelSize.value as THREE.Vector2).set(1 / w, 1 / h);
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  private disposeTargets(): void {
    for (const t of [
      this.velocity?.read, this.velocity?.write,
      this.density?.read, this.density?.write,
      this.pressure?.read, this.pressure?.write,
      this.curlRT, this.divergenceRT, this.normalRT, this.normalDeltaRT,
    ]) {
      t?.dispose();
    }
  }

  dispose(): void {
    this.disposeTargets();
    for (const m of Object.values(this.mats)) m.dispose();
    this.quad.geometry.dispose();
  }
}
