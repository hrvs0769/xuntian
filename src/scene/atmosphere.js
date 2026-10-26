// 大气层：双层壳——内层贴面散射（日出/日落暖色带），外层边缘辉光
import * as THREE from 'three';

const VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
varying vec3 vW;
varying vec2 vUv;
void main(){
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uSunset;
uniform vec3 uSunDir;
uniform float uIntensity;
uniform float uPower;
uniform float uSunsetGain;
varying vec3 vN;
varying vec3 vV;
varying vec3 vW;
varying vec2 vUv;

void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  vec3 L = normalize(uSunDir);

  float mu = abs(dot(N, V));
  float rim = pow(1.0 - mu, uPower);

  float ndl = dot(N, L);
  float day = smoothstep(-0.30, 0.42, ndl);

  // 晨昏线附近光程最长 → 暖色带
  float sunset = exp(-pow((ndl + 0.01) / 0.17, 2.0)) * uSunsetGain;

  vec3 col = mix(uColor, uSunset, clamp(sunset, 0.0, 1.0));

  // 背光面只留极淡的空气辉光（真实：夜侧几乎不可见）
  float back = smoothstep(-0.05, -0.55, ndl);
  col = mix(col, uColor * 0.55, back);

  float a = rim * (0.16 + 0.84 * day) * uIntensity;
  a *= (1.0 - 0.55 * back);

  // 极点奇异点。
  // 等距柱状球在极点把一整圈顶点收敛成一个点，晨昏线的暖色带在那里
  // 会被拉成一圈放射状条纹——从外面看就是"地球北极上方撒了一把粉黄色的碎点"。
  // 极点附近直接淡出即可：那一小块的大气在正面视角里本来也看不见。
  a *= smoothstep(0.0, 0.075, min(vUv.y, 1.0 - vUv.y));

  gl_FragColor = vec4(col * a, a);
}`;

export function createAtmosphere(radius, {
  color = 0x6fa8ff,
  sunset = 0xff7a3c,
  intensity = 1.0,
  scale = 1.026,
  power = 3.2,
  sunsetGain = 1.0,
} = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uSunset: { value: new THREE.Color(sunset) },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uIntensity: { value: intensity },
      uPower: { value: power },
      uSunsetGain: { value: sunsetGain },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * scale, 128, 96), mat);
  mesh.renderOrder = 2;
  mesh.userData.setSunDir = (v) => mat.uniforms.uSunDir.value.copy(v);
  mesh.userData.material = mat;
  return mesh;
}
