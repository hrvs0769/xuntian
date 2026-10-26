// 行星表面：单着色器覆盖岩质/气态/冰质——昼夜线、夜景灯光、海面高光、法线浮雕、环影
import * as THREE from 'three';

const VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main(){
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3  uColor;
uniform vec3  uSunDir;
uniform vec3  uAtmoColor;
uniform float uAmbient;
uniform float uAtmoRim;
uniform float uSpecPow;
uniform float uSpecGain;
uniform float uBump;
uniform float uNightGain;
uniform float uExposure;
uniform float uTerm;      // 晨昏线宽度：大气越厚越软
uniform float uGrazing;   // 晨昏线暖化强度
uniform float uLimb;      // 临边昏暗：把"平圆盘"吹成球

#ifdef USE_NIGHT
uniform sampler2D uNight;
#endif
#ifdef USE_SPEC
uniform sampler2D uSpec;
#endif
#ifdef USE_NORMAL
uniform sampler2D uNormal;
#endif
#ifdef USE_RINGSHADOW
uniform vec3  uRingNormal;
uniform vec3  uRingCenter;
uniform float uRingInner;
uniform float uRingOuter;
uniform float uRingDark;
uniform sampler2D uRingMap;
#endif

varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;

mat3 cotangentFrame(vec3 N, vec3 p, vec2 uv){
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-12);
  return mat3(T * invmax, B * invmax, N);
}

void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = normalize(uSunDir);

#ifdef USE_NORMAL
  mat3 TBN = cotangentFrame(N, -V, vUv);
  vec3 nt = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;
  // 掠射角处屏幕导数退化，切线空间会炸开成毛刺 → 边缘淡出浮雕
  float bumpFade = smoothstep(0.0, 0.26, dot(N, V));
  // UV 极点是奇异点：法线贴图在那里会炸成噪点，一并淡出
  bumpFade *= smoothstep(0.02, 0.13, min(vUv.y, 1.0 - vUv.y));
  // 晨昏线附近同理：未被扰动的法线一旦背光，扰动就会在黑暗里点出一片毛刺
  bumpFade *= smoothstep(-0.10, 0.16, dot(N, normalize(uSunDir)));
  nt.xy *= uBump * bumpFade;
  N = normalize(TBN * normalize(nt));
#endif

  vec3 albedo = texture2D(uMap, vUv).rgb * uColor;

  float ndl = dot(N, L);
  float lam = max(ndl, 0.0);
  float shade = smoothstep(-uTerm, uTerm * 1.25, ndl);
  // 朗伯 + 一点点边缘提亮（球面在视线边缘的积分效应）
  float lit = shade * (0.54 + 0.56 * lam);

  // 临边昏暗。
  // 一个纯朗伯球在太阳位于相机背后时，整个圆面亮度是常数——那正是"塑料球"的来源。
  // 真实天体不是理想朗伯体：风化层有微阴影、大气有散射，亮度总要往边缘掉。
  // 这一项几乎不增加成本，却是"圆盘 → 球体"之间最关键的一步。
  float mu = clamp(dot(N, V), 0.0, 1.0);
  lit *= mix(1.0, 0.22 + 0.78 * pow(mu, 0.55), uLimb);

  vec3 col = albedo * lit;

#ifdef USE_RINGSHADOW
  {
    float denom = dot(L, uRingNormal);
    if (abs(denom) > 1e-6){
      float t = dot(uRingCenter - vW, uRingNormal) / denom;
      if (t > 0.0){
        vec3 q = vW + L * t;
        float rr = length(q - uRingCenter);
        // 采样环的径向剖面：缝隙会透光，于是行星表面出现明暗相间的影子
        float ru = clamp((rr - uRingInner) / (uRingOuter - uRingInner), 0.0, 1.0);
        // 环的细密环纹不该原样投到行星上：那会让整个盘面变成一张等高线图。
        // 用 mip bias 直接取粗一级的剖面，主环带与卡西尼缝留下，细纹被平均掉。
        float dens = texture2D(uRingMap, vec2(ru, 0.5), 3.0).a;
        // 太阳不是一个点：环的内外缘在行星上各自留一道半影
        float pen = uRingInner * 0.012;
        dens *= smoothstep(uRingInner - pen, uRingInner + pen, rr)
              * (1.0 - smoothstep(uRingOuter - pen, uRingOuter + pen, rr));
        col *= 1.0 - uRingDark * dens;
      }
    }
  }
#endif

  // 环境光不受环影遮蔽（散射光从四面八方来），放在环影之后
  col += albedo * uAmbient;

#ifdef USE_SPEC
  {
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), uSpecPow);
    float mask = texture2D(uSpec, vUv).r;
    // 太阳的像不是点，海面高光会被波浪打散：叠一层低频抖动
    float wob = 0.62 + 0.38 * sin(vUv.x * 96.0) * sin(vUv.y * 78.0)
                * (0.6 + 0.4 * sin(vUv.x * 233.0 + vUv.y * 191.0));
    col += vec3(1.0, 0.96, 0.88) * spec * mask * uSpecGain * shade * wob;
  }
#endif

#ifdef USE_NIGHT
  {
    // 用未扰动的几何法线判断昼夜：扰动后的 N 在晨昏线附近会翻负，
    // 城市灯光就会渗到亮面上，看起来像一堆粉紫色的碎点。
    float nightMask = 1.0 - smoothstep(-0.06, 0.02, dot(normalize(vN), L));
    nightMask *= smoothstep(0.0, 0.05, min(vUv.y, 1.0 - vUv.y));
    vec3 lights = texture2D(uNight, vUv).rgb;
    // 只取亮部，压掉底噪
    float lum = max(max(lights.r, lights.g), lights.b);
    lights *= smoothstep(0.045, 0.34, lum);
    col += lights * uNightGain * nightMask;
  }
#endif

  // 晨昏线暖化：斜射光穿过更厚的大气
  float grazing = smoothstep(0.0, 0.30, lam) * (1.0 - smoothstep(0.30, 0.60, lam));
  col *= mix(vec3(1.0), vec3(1.14, 0.84, 0.64), grazing * uGrazing);

  // 边缘大气辉光（贴在球面上，与外壳叠加）
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.5);
  col += uAtmoColor * rim * shade * uAtmoRim;

  gl_FragColor = vec4(col * uExposure, 1.0);
}`;

export function makeSurfaceMaterial({
  map = null,
  normalMap = null,
  specMap = null,
  nightMap = null,
  color = 0xffffff,
  sunDir = new THREE.Vector3(1, 0, 0),
  ambient = 0.012,
  atmoColor = 0x000000,
  atmoRim = 0.0,
  specPow = 90,
  specGain = 0,
  bump = 1.0,
  nightGain = 0,
  exposure = 1.0,
  term = 0.10,
  grazing = 0.5,
  limb = 0.45,
  ringShadow = null,
} = {}) {
  const defines = {};
  if (nightMap) defines.USE_NIGHT = '';
  if (specMap) defines.USE_SPEC = '';
  if (normalMap) defines.USE_NORMAL = '';
  if (ringShadow) defines.USE_RINGSHADOW = '';

  const uniforms = {
    uMap: { value: map },
    uColor: { value: new THREE.Color(color) },
    uSunDir: { value: sunDir.clone() },
    uAtmoColor: { value: new THREE.Color(atmoColor) },
    uAmbient: { value: ambient },
    uAtmoRim: { value: atmoRim },
    uSpecPow: { value: specPow },
    uSpecGain: { value: specGain },
    uBump: { value: bump },
    uNightGain: { value: nightGain },
    uExposure: { value: exposure },
    uTerm: { value: term },
    uGrazing: { value: grazing },
    uLimb: { value: limb },
  };
  if (nightMap) uniforms.uNight = { value: nightMap };
  if (specMap) uniforms.uSpec = { value: specMap };
  if (normalMap) uniforms.uNormal = { value: normalMap };
  if (ringShadow) {
    uniforms.uRingNormal = { value: ringShadow.normal.clone() };
    uniforms.uRingCenter = { value: new THREE.Vector3() };
    uniforms.uRingInner = { value: ringShadow.inner };
    uniforms.uRingOuter = { value: ringShadow.outer };
    uniforms.uRingDark = { value: ringShadow.dark ?? 0.85 };
    uniforms.uRingMap = { value: ringShadow.map ?? null };
  }

  const mat = new THREE.ShaderMaterial({
    uniforms,
    defines,
    vertexShader: VERT,
    fragmentShader: FRAG,
    toneMapped: false,
  });
  mat.userData.ringShadow = !!ringShadow;
  return mat;
}
