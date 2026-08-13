import * as THREE from 'three';

/**
 * The second, independent simulation: a damped wave equation that hugs the
 * cursor. Two channels of one texture hold current and previous height
 * (Verlet-in-a-texture), the injection is a capsule along the mouse segment
 * whose ring width PULSES over time, and the neighbours are sampled 3.6
 * texels out for wider, softer waves.
 */

export const RIPPLE_SIM_SIZE = 384;
const SIM_SIZE = RIPPLE_SIM_SIZE;

const VERT = /* glsl */ `
in vec2 position;
in vec2 uv;
out vec2 vUv;
out vec2 vUvA;
uniform vec2 aspect;
void main() {
  vUv = uv;
  vUvA = uv * aspect;
  gl_Position = vec4(position, 0., 1.);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec2 vUvA;
out vec2 fragColor;
uniform vec2 aspect, texelSize, pointer, oldPointer;
uniform float seconds, renderPointer;
uniform sampler2D map;
#define pi 3.141592653589793
/* Damping and injection are a pair. The captured 0.98 assumes a brief
   stroke; under a sustained sweep it accumulates energy across the whole
   domain until every texel has slope and the consumer paints the entire
   screen blue. Faster decay plus a gentler impulse keeps the shimmer
   local to the cursor, which is the point of this sim. */
#define simDamping 0.962
#define rippleGain 0.6
#define trailSize 0.035
#define trailPulseWidth 0.02
#define trailPulseFrequency pi * 4.

void main() {
  vec2 uv = vUv;
  float ripple = 0.;
  if (renderPointer > 0.) {
    vec2 pA = pointer * aspect, oPA = oldPointer * aspect;
    float d;
    vec2 po = pA - oPA; float lpo = length(po);
    if (lpo < 1e-4) d = distance(vUvA, pA);
    else {
      vec2 npo = normalize(po);
      float projectedD = clamp(dot(vUvA - oPA, npo), 0., lpo);
      d = distance(vUvA, oPA + npo * projectedD);
    }
    ripple = smoothstep(trailSize + sin(seconds * trailPulseFrequency) * trailPulseWidth, 0., d)
           * smoothstep(0., 0.01, lpo);
  }

  vec3 e = vec3(3.6 * texelSize, 0.);
  float t = texture(map, uv - e.zy).x;
  float b = texture(map, uv + e.zy).x;
  float l = texture(map, uv - e.xz).x;
  float r = texture(map, uv + e.xz).x;
  vec2 prev = texture(map, uv).xy;
  float res = ripple * rippleGain + (t + r + b + l) * 0.5 - prev.y;
  res *= simDamping;
  // Hard ceiling: a stalled frame or batched events must not let the
  // field run away into a standing wave that never decays.
  res = clamp(res, -1.5, 1.5);
  fragColor = vec2(res, prev.x);
}
`;

export class RippleSim {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private material: THREE.RawShaderMaterial;
  private read: THREE.WebGLRenderTarget;
  private write: THREE.WebGLRenderTarget;
  private pointer = new THREE.Vector2(-1, -1);
  private oldPointer = new THREE.Vector2(-1, -1);
  private hasPointer = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const make = () =>
      new THREE.WebGLRenderTarget(SIM_SIZE, SIM_SIZE, {
        type: THREE.HalfFloatType,
        format: THREE.RGFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
    this.read = make();
    this.write = make();

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        aspect: { value: new THREE.Vector2(1, 1) },
        texelSize: { value: new THREE.Vector2(1 / SIM_SIZE, 1 / SIM_SIZE) },
        pointer: { value: this.pointer },
        oldPointer: { value: this.oldPointer },
        seconds: { value: 0 },
        renderPointer: { value: 0 },
        map: { value: null },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  get texture(): THREE.Texture {
    return this.read.texture;
  }

  setAspect(aspect: number): void {
    (this.material.uniforms.aspect.value as THREE.Vector2).set(aspect, 1);
  }

  setPointer(x: number, y: number): void {
    /* First event, or a jump too long to be a stroke (tab refocus, cursor
       re-entry): collapse both points onto the new position so no phantom
       wave is stamped from wherever the pointer used to be. */
    const first = this.pointer.x < 0;
    const jump = !first && Math.hypot(x - this.pointer.x, y - this.pointer.y) > 0.25;
    if (first || jump) {
      this.pointer.set(x, y);
      this.oldPointer.set(x, y);
      this.hasPointer = true;
      return;
    }
    this.oldPointer.copy(this.pointer);
    this.pointer.set(x, y);
    this.hasPointer = true;
  }

  step(seconds: number): void {
    this.material.uniforms.seconds.value = seconds;
    this.material.uniforms.renderPointer.value = this.hasPointer ? 1 : 0;
    this.material.uniforms.map.value = this.read.texture;
    this.renderer.setRenderTarget(this.write);
    this.renderer.render(this.scene, this.camera);
    const t = this.read;
    this.read = this.write;
    this.write = t;
    this.oldPointer.copy(this.pointer);
  }

  dispose(): void {
    this.read.dispose();
    this.write.dispose();
    this.material.dispose();
  }
}
