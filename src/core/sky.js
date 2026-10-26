// 天空：一次性烘焙银河（HDR 等距柱状贴图）+ 程序化星场
// 银河用贴图而非逐帧着色——在集显上省下 40% 的帧时间，且星点仍由 Points 层保持锐利。
import * as THREE from 'three';

// —— 银道坐标系基向量（场景坐标，Y = 黄道北） ——
function dirFromEcl(lonDeg, latDeg) {
  const l = lonDeg * Math.PI / 180, b = latDeg * Math.PI / 180;
  return new THREE.Vector3(
    Math.cos(b) * Math.cos(l),
    Math.sin(b),
    -Math.cos(b) * Math.sin(l)
  );
}

const GAL_CENTER = dirFromEcl(266.98, -5.54).normalize();
const GAL_POLE = dirFromEcl(180.0, 29.78).normalize();

function galBasis() {
  const gy = GAL_POLE.clone();
  const gx = GAL_CENTER.clone().sub(gy.clone().multiplyScalar(GAL_CENTER.dot(gy))).normalize();
  const gz = new THREE.Vector3().crossVectors(gx, gy).normalize();
  return new THREE.Matrix3().set(
    gx.x, gx.y, gx.z,
    gy.x, gy.y, gy.z,
    gz.x, gz.y, gz.z
  );
}

const GAL_MAT = galBasis();

const GALAXY_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform mat3 uGal;

float hash31(vec3 p){
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
                mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y);
  float b = mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
                mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y);
  return mix(a, b, f.z);
}
float fbm(vec3 p, int oct){
  float v = 0.0, a = 0.55;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    v += a * noise3(p);
    p *= 2.13;
    a *= 0.5;
  }
  return v;
}

void main(){
  float lon = (vUv.x - 0.5) * 6.28318530718;
  float lat = (vUv.y - 0.5) * 3.14159265359;
  vec3 d = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));

  vec3 g = uGal * d;
  float b = asin(clamp(g.y, -1.0, 1.0));
  float l = atan(g.z, g.x);

  float core = exp(-pow(l / 0.72, 2.0));
  float band = exp(-pow(b / mix(0.085, 0.150, core), 2.0));   // 银河主带
  float spine = exp(-pow(b / 0.030, 2.0));                    // 极窄的银道亮脊
  float halo = exp(-pow(b / 0.36, 2.0));

  float c1 = fbm(d * 11.0, 4);
  float c2 = fbm(d * 27.0 + 4.3, 3);
  float c3 = fbm(d * 66.0 + 11.0, 2);
  float clouds = c1 * 0.50 + c2 * 0.32 + c3 * 0.18;

  // 尘埃带：沿银道面撕开的暗缝（真实银河最显著的特征）
  float dustField = fbm(d * 19.0 + vec3(9.0, 2.0, 5.0), 4);
  float dust = smoothstep(0.44, 0.58, dustField) * exp(-pow(b / 0.062, 2.0));

  float dens = band * (0.06 + 1.45 * clouds * clouds);
  dens += spine * (0.30 + 0.85 * clouds * clouds) * mix(0.35, 1.0, core);
  // 尘埃带要锐：真实的银河是被一道道黑缝切开的，不是一层均匀的雾。
  dens *= (1.0 - 0.93 * dust);
  // halo 原来给到 0.05，在银纬 ±20° 内铺出一大团蓝灰色的雾。
  // 深空里那看起来不像银河，像镜头脏了。
  dens += halo * 0.014 * (0.35 + 0.85 * clouds);

  vec3 warm = vec3(1.00, 0.84, 0.63);
  vec3 cool = vec3(0.58, 0.70, 1.00);
  vec3 col = mix(cool, warm, clamp(core * 0.9 + 0.1, 0.0, 1.0));
  col *= dens * mix(0.40, 1.0, core);

  col += vec3(0.00055, 0.00075, 0.00145);

  gl_FragColor = vec4(col * 0.115, 1.0);
}
`;

/** 烘焙银河（一次性），返回可作 scene.background 的贴图 */
export function bakeGalaxy(renderer) {
  const W = 2048, H = 1024;
  const rt = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: true,
    depthBuffer: false,
  });

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: GALAXY_FRAG,
    uniforms: { uGal: { value: GAL_MAT } },
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  scene.add(quad);

  const prevTarget = renderer.getRenderTarget();
  const prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.toneMapping = prevTone;

  quad.geometry.dispose();
  mat.dispose();

  rt.texture.mapping = THREE.EquirectangularReflectionMapping;
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt.texture;
}

// —— 星场 ——
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAR_TINTS = [
  [0.66, 0.76, 1.00],
  [0.78, 0.85, 1.00],
  [0.94, 0.96, 1.00],
  [1.00, 0.98, 0.93],
  [1.00, 0.92, 0.76],
  [1.00, 0.80, 0.58],
  [1.00, 0.68, 0.48],
];

export function createStars(count = 11000, radius = 6000) {
  const rnd = mulberry(7782331);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const siz = new Float32Array(count);
  const alp = new Float32Array(count);

  const pole = GAL_POLE;
  const u = new THREE.Vector3(1, 0, 0).cross(pole).normalize();
  const v = new THREE.Vector3().crossVectors(pole, u).normalize();

  let i = 0;
  while (i < count) {
    const inBand = rnd() < 0.36;
    let dir;
    if (inBand) {
      const bb = (rnd() + rnd() + rnd() - 1.5) * 0.22;
      const ll = rnd() * Math.PI * 2;
      dir = new THREE.Vector3()
        .addScaledVector(u, Math.cos(ll) * Math.cos(bb))
        .addScaledVector(v, Math.sin(ll) * Math.cos(bb))
        .addScaledVector(pole, Math.sin(bb));
    } else {
      const z = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      dir = new THREE.Vector3(s * Math.cos(t), z, s * Math.sin(t));
    }
    dir.normalize();

    pos[i * 3] = dir.x * radius;
    pos[i * 3 + 1] = dir.y * radius;
    pos[i * 3 + 2] = dir.z * radius;

    const m = Math.pow(rnd(), 4.0);
    alp[i] = 0.20 + m * 0.80;

    const ti = Math.min(STAR_TINTS.length - 1, Math.floor(Math.pow(rnd(), 0.85) * STAR_TINTS.length));
    const t = STAR_TINTS[ti];
    const j = 0.9 + rnd() * 0.16;
    col[i * 3] = t[0] * j; col[i * 3 + 1] = t[1] * j; col[i * 3 + 2] = t[2] * j;

    siz[i] = 0.65 + Math.pow(rnd(), 6) * 3.2;
    i++;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alp, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) } },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
      varying vec3 vColor; varying float vAlpha;
      uniform float uPixelRatio;
      void main(){
        vColor = aColor; vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.0, aSize * uPixelRatio);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vec2 q = gl_PointCoord - 0.5;
        float d = length(q);
        float core = smoothstep(0.5, 0.0, d);
        float a = pow(core, 2.8) + pow(core, 0.8) * 0.18;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor * vAlpha, a * vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -10;
  return pts;
}
