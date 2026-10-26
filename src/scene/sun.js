// 太阳：光球（米粒 + 黑子 + 临边昏暗）、色球细环、盔状流日冕、点光源
//
// 影调要点：所有材质都走 ACESFilmic（three 内部会先乘 1/0.6 曝光）。
// 线性 1.45 → sRGB ≈ 0.92，线性 0.55 → sRGB ≈ 0.79。
// 日面核心必须略高于泛光阈值（1.12），让光晕从核心溢出而不是整个圆面一起泛白。
import * as THREE from 'three';

// 4 通道可平铺噪声贴图（4 个倍频），供光球着色器廉价采样
export function makeNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const octave = [4, 8, 16, 32];
  const perm = new Uint8Array(512);
  let seed = 1337;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  const fade = t => t * t * (3 - 2 * t);
  const grad = (h, x, y) => {
    switch (h & 3) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      default: return -x - y;
    }
  };
  const noise2 = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
    const x1 = grad(aa, xf, yf) * (1 - u) + grad(ba, xf - 1, yf) * u;
    const x2 = grad(ab, xf, yf - 1) * (1 - u) + grad(bb, xf - 1, yf - 1) * u;
    return (x1 * (1 - v) + x2 * v) * 0.7 + 0.5;
  };

  for (let c = 0; c < 4; c++) {
    const freq = octave[c];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size * freq, v = y / size * freq;
        // 平铺：在周期边界上混合
        const a = noise2(u, v);
        const b = noise2(u - freq, v);
        const cc = noise2(u, v - freq);
        const d = noise2(u - freq, v - freq);
        const fx = x / size, fy = y / size;
        const val = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + cc * (1 - fx) * fy + d * fx * fy;
        data[(y * size + x) * 4 + c] = Math.max(0, Math.min(255, val * 255));
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const PHOTOSPHERE_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vPos;
void main(){
  vUv = uv;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  vPos = position;
  gl_Position = projectionMatrix * mv;
}`;

const PHOTOSPHERE_FRAG = /* glsl */`
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uCore;      // 中心颜色（含亮度）
uniform vec3 uLimb;      // 临边的色相（只做颜色，亮度由 bri 负责）
uniform float uDetail;   // 日面在屏幕上的像素半径决定细节层级
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vPos;

// 双层缓慢漂移，让米粒有"沸腾"的方向感
vec2 drift(vec2 uv, float t, float s){
  return uv + vec2(t * 0.0026 * s, t * 0.0013 * s);
}

void main(){
  // —— 米粒组织 ——
  // 先说清一件事：真实米粒的直径约 1000 km，太阳直径 1.39×10^6 km，
  // 也就是整个可见日面上排着约 1400 颗。在 700 px 的日面上，一颗只有半个像素。
  // 所以"满屏米粒"本身就是不真实的——上一版把噪声等值线画成细网，
  // 得到的是一张大理石纹/等高线地图。
  //
  // 正确的做法：中心几乎看不见（只剩一点极弱的沸腾感），
  // 临边因为视线斜穿、米粒被径向拉长，才逐渐显形。
  float n1 = texture2D(uNoise, drift(vUv * 2.6,  uTime,  1.0)).r;  // 超米粒
  float n2 = texture2D(uNoise, drift(vUv * 13.0, uTime, -1.7)).g;  // 米粒
  float n3 = texture2D(uNoise, drift(vUv * 30.0, uTime,  2.6)).b;  // 细米粒
  float n4 = texture2D(uNoise, drift(vUv * 44.0, uTime, -3.9)).a;  // 微纹

  // 暗壁网络：两层噪声的等值线取并集。
  // 只用一层会得到规整的"鱼鳞"——等值线全是同一尺度的闭合环。
  float wall = min(abs(n2 - 0.5), abs(n3 - 0.5) * 1.45);
  float cell = smoothstep(0.0, 0.16, wall * 2.0);

  // 临边昏暗（Eddington 近似）：边缘亮度约为中心的四成
  float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  // 轮廓不是完美圆弧：加一点噪声让边缘微微起伏
  float edgeJitter = (texture2D(uNoise, vec2(vUv.x * 3.0, 0.5)).r - 0.5) * 0.02;
  mu = clamp(mu + edgeJitter, 0.0, 1.0);

  // 米粒的可见度随 mu 变化：中心 2%，临边 9%
  float granVis = mix(0.145, 0.052, mu);
  float gran = 1.0 + (cell - 0.55) * granVis * 2.0;
  gran *= 1.0 + (n4 - 0.5) * 0.014;   // 微纹：只提供一点"沸腾感"
  gran *= 1.0 + (n1 - 0.5) * 0.034;   // 超米粒的大尺度起伏

  // 极点：等距柱状贴图把整条 u 压成一点，网络会收敛成一个"风车"
  gran = mix(1.0, gran, smoothstep(0.0, 0.13, min(vUv.y, 1.0 - vUv.y)));

  // 小到只有几个像素时，临边昏暗与米粒都会退化成脏噪点 → 整体淡出
  float bri = mix(1.0, 0.38 + 0.62 * pow(mu, 0.72), uDetail);
  // 中心 5800K 的黑体在 sRGB 上几乎是纯白，只偏一点点黄；
  // 临边因为斜穿更冷的高层，转成橙。
  vec3 tint = mix(uLimb, vec3(1.0), pow(mu, 0.45));

  vec3 col = uCore * tint * bri * mix(1.0, gran, uDetail);

  // —— 黑子 ——
  // 用低频通道。高频噪声会撒出上百个小黑点，像发霉；
  // 真实的黑子成对/成群，只出现在纬度 ±5°~30° 的活动带。
  float sf = texture2D(uNoise, vUv * 2.2 + vec2(0.31, 0.77)).r;
  float lat = abs(vUv.y - 0.5) * 2.0;                     // 0 赤道 → 1 极点
  float belt = smoothstep(0.46, 0.30, lat) * smoothstep(0.035, 0.105, lat);

  // 半影 / 本影的过渡要宽。窄过渡会让黑子变成一个个"破洞"——
  // 真实的黑子边缘是纤维状向外发散的，不是刀切的椭圆。
  float pen = smoothstep(0.560, 0.680, sf) * belt;        // 半影
  float umb = smoothstep(0.645, 0.700, sf) * belt;        // 本影

  // 亮度比按黑体温度算：半影 ~5000K → (5000/5800)^4 ≈ 0.55，
  // 本影 ~4000K → 0.23。之前乘到 0.18 是纯黑，看着像球被戳穿了。
  col *= 1.0 - 0.45 * pen;
  col *= 1.0 - 0.55 * umb;

  // 活动区外的光斑（faculae）：黑子群周围更亮的一点
  float fac = smoothstep(0.545, 0.600, sf) * belt * (1.0 - pen);
  col += vec3(1.0, 0.94, 0.80) * fac * 0.10 * uDetail;

  // —— 色球 ——
  // 只有太阳半径的 0.3%：在 700px 的日面上是两像素。再宽就成了一圈描边。
  float rim = pow(1.0 - mu, 44.0) * uDetail;
  col += vec3(1.0, 0.30, 0.10) * rim * 0.55;

  gl_FragColor = vec4(col, 1.0);
}`;

const CORONA_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const CORONA_FRAG = /* glsl */`
uniform float uTime;
uniform float uInner;   // 光球在 quad 里的归一化半径
uniform float uGain;
uniform float uPoint;   // 1 = 天体在屏幕上只剩几个像素
varying vec2 vUv;

// 不用 sin 的哈希：sin(dot(p,...)) 在坐标变大后精度崩塌，
// 会退化成大块常数，看起来像"矩形光斑"。
float hash(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main(){
  vec2 q = vUv * 2.0 - 1.0;
  float r = length(q);
  if (r > 1.0) discard;
  if (r < uInner) discard;              // 日面由光球绘制

  float ang = atan(q.y, q.x);
  float x = r / uInner - 1.0;           // 以光球半径为单位的向外距离
  vec2 ca = vec2(cos(ang), sin(ang));

  // —— 角向结构 ——
  // 角向噪声必须建在单位圆上（cos/sin），否则 atan 在 ±π 处的断点
  // 会沿 -x 方向撕出一条假的亮射线。
  float s1 = noise(ca * 1.9 + 3.0);     // 宽瓣：决定有几条盔状流
  float s2 = noise(ca * 4.6 + 21.3);    // 中瓣
  float s3 = noise(ca * 13.0 + 41.7);   // 细羽

  // 盔状流（helmet streamer）。
  // 真实的日冕不是均匀放射的星芒——那是滤镜的语法。
  // 它只有两三条从活动区伸出的宽流束，末端张开成盔形，其余方向很快熄灭。
  float helm = smoothstep(0.42, 0.86, s1 * 0.74 + s2 * 0.26);

  // 三段叠加
  // 内冕：各向同性的柔光，衰减极快
  float a = 0.38 * exp(-x * 3.2);
  // 盔状流：长度随方向大幅变化
  a += helm * 0.62 * exp(-x / (0.42 + 1.15 * helm));
  // 极区羽流：短而密，只在贴近日面处
  a += 0.085 * s3 * exp(-x * 4.2);

  // 赤道方向整体更长（活动极小期的典型形态：赤道有"翅膀"）
  a *= 0.70 + 0.30 * pow(abs(cos(ang - 0.18)), 1.6);

  // 流束沿半径断续：是一串团块，不是一根均匀的线
  float clump = noise(vec2(x * 1.15, ca.x * 2.0 + ca.y * 1.7));
  a *= 0.82 + 0.30 * clump;

  // 流束内部的纤维：沿半径拉长的细丝，只在盔状流里出现。
  // 没有这一层，日冕永远是一团柔光——羽状结构正是它与"发光云"的区别。
  float fiber = noise(vec2(ca.x * 10.0 + ca.y * 8.0, x * 1.2));
  a *= 1.0 + (fiber - 0.5) * 0.72 * smoothstep(0.30, 0.85, helm);

  // 贴近日面的一层极亮薄环（色球 + 内冕）
  a += exp(-pow((x - 0.020) / 0.055, 2.0)) * 0.22;

  // 远距时补一层柔和外晕：几像素的日面 + 紧贴的日冕会显得"脏"，需要光晕托底
  float halo = 0.16 / (1.0 + pow(x * 0.60, 1.5));
  a += halo * uPoint;

  // 颜色：近处暖白，外缘转成极淡的冷白（F 冕的散射）
  vec3 col = mix(vec3(1.0, 0.94, 0.86), vec3(0.80, 0.86, 1.0), smoothstep(0.05, 0.85, x) * 0.55);

  a *= uGain;
  gl_FragColor = vec4(col * a, a);
}`;

export function createSun(radius, noiseTex) {
  const group = new THREE.Group();
  group.name = 'sun';

  // —— 光球 ——
  // 线性 1.45 → sRGB ≈ 0.92：刺眼，但米粒还没被 ACES 压平。
  // 核心要略高于泛光阈值（1.12），光晕才会从核心溢出来，
  // 而不是整个圆面一起泛白——那会让太阳变成一块灰白的圆片。
  const core = new THREE.Color(1.0, 0.975, 0.925).multiplyScalar(1.45);
  const limb = new THREE.Color(1.0, 0.62, 0.30);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNoise: { value: noiseTex },
      uTime: { value: 0 },
      uCore: { value: core },
      uLimb: { value: limb },
      uDetail: { value: 1 },
    },
    vertexShader: PHOTOSPHERE_VERT,
    fragmentShader: PHOTOSPHERE_FRAG,
    toneMapped: false,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 128, 96), mat);
  sphere.name = 'photosphere';
  group.add(sphere);

  // —— 日冕（始终面向相机的圆片）——
  const CORONA_SPAN = 7.0;   // 直径 = 7 倍太阳直径 → 半径向外延伸 2.5 倍
  const coronaMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uInner: { value: 1 / (CORONA_SPAN * 0.5) },
      uGain: { value: 0.74 },
      uPoint: { value: 0 },
    },
    vertexShader: CORONA_VERT,
    fragmentShader: CORONA_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const corona = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), coronaMat);
  corona.scale.setScalar(radius * CORONA_SPAN);
  corona.renderOrder = 3;
  corona.name = 'corona';
  group.add(corona);

  // —— 太阳光（无衰减点光源，方向正确、亮度不随距离衰减）——
  const light = new THREE.PointLight(0xfff2e0, 3.4, 0, 0);
  light.name = 'sunlight';
  group.add(light);

  group.userData.update = (t, camera) => {
    mat.uniforms.uTime.value = t;
    coronaMat.uniforms.uTime.value = t;
    if (camera) corona.quaternion.copy(camera.quaternion);
  };
  group.userData.radius = radius;
  group.userData.light = light;
  group.userData.coronaSpan = CORONA_SPAN;

  return group;
}
