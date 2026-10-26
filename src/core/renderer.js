// 渲染管线：HDR → 泛光 → ACES → FXAA + 调色（暗角/颗粒/色散/抖动）
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 0.52 },
    // 颗粒只用来压暗部色带，不该在中亮区被看见。
    // 之前 0.019 + 每帧重新随机，在月球这种大面积中亮区上是 ±1 色阶的沙沙抖动，
    // 静止画面看起来像"在颤"。降到 0.011 并把亮部衰减改成 1.7 次方。
    uGrain: { value: 0.011 },
    uAberration: { value: 0.0007 },
    uAA: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uRes;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uAA;
    varying vec2 vUv;

    float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

    vec3 fxaa(vec2 uv, vec2 rcp){
      vec3 rgbNW = texture2D(tDiffuse, uv + vec2(-1.0, -1.0) * rcp).rgb;
      vec3 rgbNE = texture2D(tDiffuse, uv + vec2( 1.0, -1.0) * rcp).rgb;
      vec3 rgbSW = texture2D(tDiffuse, uv + vec2(-1.0,  1.0) * rcp).rgb;
      vec3 rgbSE = texture2D(tDiffuse, uv + vec2( 1.0,  1.0) * rcp).rgb;
      vec3 rgbM  = texture2D(tDiffuse, uv).rgb;
      vec3 luma = vec3(0.299, 0.587, 0.114);
      float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma);
      float lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma), lM = dot(rgbM, luma);
      float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
      float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
      float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
      float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
      dir = min(vec2(8.0), max(vec2(-8.0), dir * rcpDirMin)) * rcp;

      vec3 rgbA = 0.5 * (texture2D(tDiffuse, uv + dir * (1.0 / 3.0 - 0.5)).rgb
                       + texture2D(tDiffuse, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
      vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, uv + dir * -0.5).rgb
                                     + texture2D(tDiffuse, uv + dir *  0.5).rgb);
      float lB = dot(rgbB, luma);
      return (lB < lMin || lB > lMax) ? rgbA : rgbB;
    }

    void main(){
      vec2 rcp = 1.0 / uRes;
      vec3 col = uAA > 0.5 ? fxaa(vUv, rcp) : texture2D(tDiffuse, vUv).rgb;

      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);

      // 边缘色散：只在外圈，且量很小
      float ab = uAberration * r2 * r2 * 6.0;
      if (ab > 1e-6){
        col.r = texture2D(tDiffuse, vUv + d * ab).r;
        col.b = texture2D(tDiffuse, vUv - d * ab).b;
      }

      // 暗角
      float vig = smoothstep(1.16, 0.26, length(d) * 1.32);
      col *= mix(1.0, vig, uVignette);

      // 颗粒：只在暗部起作用（压色带）。亮部必须绝对干净——
      // 一个中灰的球面上每帧 ±1 色阶的随机噪声，人眼会读成"画面在抖"。
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      float g = rand(vUv * uRes + fract(uTime * 0.37) * 137.0) - 0.5;
      col += g * uGrain * pow(max(1.0 - lum, 0.0), 1.7);

      // 抖动，消除暗部色带
      col += (rand(vUv * uRes + 7.3) - 0.5) / 255.0;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    logarithmicDepthBuffer: false,
    powerPreference: 'high-performance',
    alpha: false,
    stencil: false,
  });
  // 高 DPI 屏上 1.6 倍已足够锐利；再高只是白烧填充率
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = true;
  return renderer;
}

export function createComposer(renderer, scene, camera) {
  const w = window.innerWidth, h = window.innerHeight;
  const pr = renderer.getPixelRatio();
  const q = new URLSearchParams(location.search);

  const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, {
    type: THREE.HalfFloatType,
    samples: 0,
    colorSpace: THREE.LinearSRGBColorSpace,
  });

  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // 半分辨率泛光：视觉几乎无差别，省一半模糊开销
  // 阈值 1.12：只有太阳日面核心（线性 1.45）与色球会溢出光晕。
  // 阈值放在 0.95 时整个日面都在泛光，米粒被辉光糊平，太阳成了一块灰白圆片。
  const bloomScale = q.has('bs') ? Number(q.get('bs')) : 0.5;
  const bloom = new UnrealBloomPass(new THREE.Vector2(w * bloomScale, h * bloomScale), 0.40, 0.58, 1.22);
  bloom.setSize(w * bloomScale, h * bloomScale);
  if (q.get('bloom') !== '0') composer.addPass(bloom);

  const output = new OutputPass();
  composer.addPass(output);

  const grade = new ShaderPass(GradeShader);
  grade.uniforms.uAA.value = q.get('fxaa') === '0' ? 0 : 1;
  grade.renderToScreen = true;
  composer.addPass(grade);

  grade.uniforms.uRes.value.set(w * pr, h * pr);

  return { composer, bloom, grade, renderPass, output, bloomScale };
}
