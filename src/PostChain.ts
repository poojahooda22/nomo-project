import * as THREE from 'three';

/**
 * The post pipeline: threshold -> separable Gaussian chain producing five
 * mip levels -> one composite mega-shader that un-overscans, applies the
 * squared five-level bloom, adds the mirrored per-channel radial halo
 * (lens ghosts with chromatic aberration), tonemaps with Khronos PBR
 * Neutral, converts to sRGB, and dithers with animated noise.
 */

const THRESHOLD_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D map;
uniform float threshold, softWidth;
void main() {
  vec3 color = texture2D(map, vUv).rgb;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float w = smoothstep(threshold - softWidth, threshold + softWidth, luma);
  gl_FragColor = vec4(color * w, 1.);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D map;
uniform vec2 direction;
void main() {
  vec3 c = texture2D(map, vUv).rgb * 0.2270270270;
  c += texture2D(map, vUv + direction * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(map, vUv - direction * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(map, vUv + direction * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(map, vUv - direction * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D map;
uniform sampler2D bloomLevel0, bloomLevel1, bloomLevel2, bloomLevel3, bloomLevel4;
uniform float bloomRadius, bloomPower;
uniform float haloShift, haloPower, haloMin, haloMax, haloAnaglyphWidth;
uniform vec2 aspectRatio, texelSize;
uniform float seconds;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

/* Khronos PBR Neutral tone mapper. */
vec3 NeutralToneMapping(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  float d = 1. - startCompression;
  float newPeak = 1. - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1. - 1. / (desaturation * (peak - newPeak) + 1.);
  return mix(color, newPeak * vec3(1.), g);
}

vec3 LinearTosRGB1(vec3 c) {
  return pow(max(c, vec3(0.)), vec3(1. / 2.2));
}

void main() {
  vec2 uv = (vUv - 0.5) / 1.25 + 0.5;   // un-overscan
  vec3 color = texture2D(map, uv).rgb;

  vec3 bloom = (
    mix(1.0, 0.2, bloomRadius) * texture2D(bloomLevel0, uv).rgb +
    mix(0.8, 0.4, bloomRadius) * texture2D(bloomLevel1, uv).rgb +
    0.6                        * texture2D(bloomLevel2, uv).rgb +
    mix(0.4, 0.8, bloomRadius) * texture2D(bloomLevel3, uv).rgb +
    mix(0.2, 1.0, bloomRadius) * texture2D(bloomLevel4, uv).rgb
  );
  color += bloomPower * bloom * bloom;

  {
    vec2 fromCenter = (vUv - 0.5) * aspectRatio;
    vec2 direction = normalize(fromCenter + vec2(1e-6));
    vec2 st = 0.5 - fromCenter + direction * haloShift;
    vec2 anaglyph = direction * texelSize.y * haloAnaglyphWidth;
    vec3 halo = 0.25 * vec3(
      texture2D(bloomLevel2, st - anaglyph).r,
      texture2D(bloomLevel2, st).g,
      texture2D(bloomLevel2, st + anaglyph).b);
    halo += vec3(
      texture2D(bloomLevel4, st - anaglyph * 8.).r,
      texture2D(bloomLevel4, st).g,
      texture2D(bloomLevel4, st + anaglyph * 8.).b);
    color += halo * haloPower * smoothstep(haloMin, haloMax, length(fromCenter));
  }

  color = NeutralToneMapping(color);
  color = LinearTosRGB1(color);
  color += rand(vUv + fract(seconds)) / 256. - 1. / 512.;
  gl_FragColor = vec4(clamp(color, 0., 1.), 1.);
}
`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0., 1.);
}
`;

export class PostChain {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private quad: THREE.Mesh;
  private thresholdMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private thresholdRT!: THREE.WebGLRenderTarget;
  private mips: { a: THREE.WebGLRenderTarget; b: THREE.WebGLRenderTarget }[] = [];
  private width = 0;
  private height = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.scene.add(this.quad);

    this.thresholdMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: THRESHOLD_FRAG,
      uniforms: {
        map: { value: null },
        threshold: { value: 1.0 },
        softWidth: { value: 0.25 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        map: { value: null },
        direction: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        map: { value: null },
        bloomLevel0: { value: null },
        bloomLevel1: { value: null },
        bloomLevel2: { value: null },
        bloomLevel3: { value: null },
        bloomLevel4: { value: null },
        bloomRadius: { value: 0.67 },
        bloomPower: { value: 0.17 },
        haloShift: { value: 0.0 },
        haloPower: { value: 0.5 },
        haloMin: { value: 0.45 },
        haloMax: { value: 0.75 },
        haloAnaglyphWidth: { value: 12.5 },
        aspectRatio: { value: new THREE.Vector2(1, 1) },
        texelSize: { value: new THREE.Vector2() },
        seconds: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.thresholdRT?.dispose();
    for (const m of this.mips) {
      m.a.dispose();
      m.b.dispose();
    }
    this.mips = [];
    const opts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };
    this.thresholdRT = new THREE.WebGLRenderTarget(width >> 1, height >> 1, opts);
    for (let i = 0; i < 5; i++) {
      const w = Math.max(1, width >> (i + 1));
      const h = Math.max(1, height >> (i + 1));
      this.mips.push({
        a: new THREE.WebGLRenderTarget(w, h, opts),
        b: new THREE.WebGLRenderTarget(w, h, opts),
      });
    }
    (this.compositeMat.uniforms.texelSize.value as THREE.Vector2).set(1 / width, 1 / height);
    const aspect = width / height;
    (this.compositeMat.uniforms.aspectRatio.value as THREE.Vector2).set(aspect, 1);
  }

  /** Full chain: sceneRT (overscanned) -> screen. */
  render(sceneRT: THREE.WebGLRenderTarget, seconds: number): void {
    this.thresholdMat.uniforms.map.value = sceneRT.texture;
    this.blit(this.thresholdMat, this.thresholdRT);

    let src: THREE.Texture = this.thresholdRT.texture;
    for (let i = 0; i < 5; i++) {
      const { a, b } = this.mips[i];
      this.blurMat.uniforms.map.value = src;
      (this.blurMat.uniforms.direction.value as THREE.Vector2).set(1 / a.width, 0);
      this.blit(this.blurMat, a);
      this.blurMat.uniforms.map.value = a.texture;
      (this.blurMat.uniforms.direction.value as THREE.Vector2).set(0, 1 / a.height);
      this.blit(this.blurMat, b);
      src = b.texture;
    }

    const u = this.compositeMat.uniforms;
    u.map.value = sceneRT.texture;
    u.bloomLevel0.value = this.mips[0].b.texture;
    u.bloomLevel1.value = this.mips[1].b.texture;
    u.bloomLevel2.value = this.mips[2].b.texture;
    u.bloomLevel3.value = this.mips[3].b.texture;
    u.bloomLevel4.value = this.mips[4].b.texture;
    u.seconds.value = seconds;
    this.quad.material = this.compositeMat;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }

  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.thresholdRT?.dispose();
    for (const m of this.mips) {
      m.a.dispose();
      m.b.dispose();
    }
    this.thresholdMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.quad.geometry.dispose();
  }
}
