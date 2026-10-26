// 土星环：程序化环带剖面 + 行星本影 + 逆光前向散射
import * as THREE from 'three';

// ── 一维值噪声 ──
// 上一版用逐 texel 的白噪声做"细纹"，结果一条细纹都看不见：
// 环在屏幕上占 ~500px，贴图 2048 texel，一个像素覆盖 4 个 texel，
// mipmap 一平均，白噪声就归零了 —— 环于是变成一块光板。
// 改成 5 个波长叠加，最粗一档只跨 1/5 个环宽，缩到屏幕上仍然有明暗。
function noise1D(n, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = rnd();
  return (x) => {
    const f = x * n;
    const i = Math.floor(f);
    const t = f - i;
    const u = t * t * (3 - 2 * t);
    return v[i % n] * (1 - u) + v[(i + 1) % n] * u;
  };
}

const OCT = [
  [5, 0.30, 11939],
  [13, 0.24, 47711],
  [37, 0.20, 91237],
  [101, 0.15, 33091],
  [277, 0.11, 71123],
].map(([n, w, seed]) => ({ f: noise1D(n, seed), w }));

// 真实分区（单位：土星赤道半径 60268 km）
// [内缘, 外缘, 光学厚度→不透明度, 亮度, 暖度]
const REGIONS = [
  [1.200, 1.236, 0.07, 0.30, 0.62],   // D 环残迹：几乎透明的尘
  [1.239, 1.527, 0.44, 0.56, 0.38],   // C 环：稀薄、偏褐
  [1.527, 1.951, 0.97, 1.00, 0.00],   // B 环：最厚最亮
  [1.951, 2.027, 0.12, 0.40, 0.34],   // 卡西尼缝
  [2.027, 2.269, 0.80, 0.87, 0.10],   // A 环
  [2.320, 2.336, 0.38, 0.68, 0.06],   // F 环：一根独立的细线
];

// [中心半径, 半宽, 深度]
const GAPS = [
  [1.452, 0.0040, 0.55],   // 麦克斯韦缝
  [1.470, 0.0020, 0.32],   // 邦德缝
  [1.951, 0.0040, 0.70],   // 惠更斯缝（卡西尼内缘）
  [2.214, 0.0027, 0.92],   // 恩克缝
  [2.263, 0.0012, 0.30],   // 哥伦比亚缝
  [2.265, 0.0006, 0.55],   // 基勒缝
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** 生成环带纹理（1D 径向剖面） */
export function makeRingTexture(planetRadius, innerR, outerR) {
  const W = 4096, H = 4;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;

  for (let x = 0; x < W; x++) {
    const rn = x / (W - 1);
    const r = innerR + (outerR - innerR) * rn;

    let a = 0, lum = 0, warm = 0;
    for (const [r0, r1, tau, l, w] of REGIONS) {
      if (r < r0 || r > r1) continue;
      // 内外缘留千分之几 R 的软化，避免刀切
      const soft = Math.min(0.004, (r1 - r0) * 0.10);
      const edge = Math.min(1, Math.min(r - r0, r1 - r) / soft + 0.02);
      a = tau * (0.30 + 0.70 * edge);
      lum = l; warm = w;
      break;
    }

    // 多尺度环纹：密处更不透明、也更亮
    let n = 0;
    if (a > 0) for (const o of OCT) n += o.f(rn) * o.w;

    // 缝隙（在环纹之后再挖，缝隙边缘要硬）
    for (const [c, hw, dep] of GAPS) {
      const dist = Math.abs(r - c);
      if (dist < hw * 3) a *= 1 - dep * (1 - smooth(0, hw * 1.6, dist));
    }

    a = clamp01(a * clamp01(0.45 + 1.10 * n));

    // 色相：B 环最亮最中性，C 环暗且褐，越外越冷
    const shade = 0.82 + 0.30 * n;
    const cr = clamp01(((172 + 62 * lum - 24 * warm) * shade) / 255);
    const cg = clamp01(((152 + 60 * lum - 36 * warm) * shade) / 255);
    const cb = clamp01(((110 + 52 * lum - 46 * warm) * shade) / 255);

    for (let y = 0; y < H; y++) {
      const o = (y * W + x) * 4;
      d[o] = Math.round(cr * 255);
      d[o + 1] = Math.round(cg * 255);
      d[o + 2] = Math.round(cb * 255);
      d[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const VERT = /* glsl */`
varying vec3 vW;
varying vec3 vN;
varying vec2 vLoc;
void main(){
  vLoc = position.xy;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uSunDir;
uniform vec3 uCenter;
uniform float uInner;
uniform float uOuter;
uniform float uPlanetRadius;
uniform float uOpacity;
varying vec3 vW;
varying vec3 vN;
varying vec2 vLoc;

void main(){
  float r = length(vLoc);
  float u = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
  vec4 tex = texture2D(uMap, vec2(u, 0.5));
  if (tex.a < 0.004) discard;

  vec3 N = normalize(vN);
  vec3 L = normalize(uSunDir);
  vec3 V = normalize(cameraPosition - vW);

  float muL = abs(dot(N, L));
  float muV = abs(dot(N, V));

  // 环是一层粒子，不是一块硬表面：
  // 正照时按光学厚度反照，逆光时粒子前向散射，环会"透亮"。
  float fwd = pow(clamp(dot(-V, L), 0.0, 1.0), 2.2);
  float bright = 0.11 + 0.52 * muL + 0.42 * fwd * (1.0 - muL * 0.55);
  // 掠射角下视线穿过更多粒子 → 变亮
  bright *= (0.70 + 0.42 * pow(muV, 0.45));

  // 行星本影投在环上：本影 + 半影
  vec3 d = vW - uCenter;
  float t = -dot(d, L);
  float shadow = 1.0;
  if (t > 0.0){
    float dist = length(d + L * t);
    shadow = smoothstep(uPlanetRadius * 0.96, uPlanetRadius * 1.18, dist);
    // 影子里的环并非全黑：行星自身的反照会把它们照亮一点
    shadow = mix(0.20, 1.0, shadow);
  }

  vec3 col = tex.rgb * bright * shadow;
  float a = tex.a * uOpacity;
  // 预乘输出：默认 NormalBlending 会把 alpha 乘两次，半透明的 C 环被压得过暗
  gl_FragColor = vec4(col * a, a);
}`;

export function createRings(planetRadius, { inner = 1.20, outer = 2.345, opacity = 0.95 } = {}) {
  const innerR = planetRadius * inner;
  const outerR = planetRadius * outer;
  const tex = makeRingTexture(planetRadius, inner, outer);

  // 环外缘在屏幕上有上千像素，384 段会让边缘出现可见的多边形折角
  const geo = new THREE.RingGeometry(innerR, outerR, 640, 4);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uCenter: { value: new THREE.Vector3() },
      uInner: { value: innerR },
      uOuter: { value: outerR },
      uPlanetRadius: { value: planetRadius },
      uOpacity: { value: opacity },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 4;
  mesh.userData.material = mat;
  mesh.userData.inner = innerR;
  mesh.userData.outer = outerR;
  return mesh;
}
