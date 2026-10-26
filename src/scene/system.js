// 系统装配：太阳、八行星、月球、轨道线
import * as THREE from 'three';
import { SUN, PLANETS, MOON } from '../data/bodies.js';
import { AU_KM, positionsAt, sampleOrbit, spinAngle } from '../core/ephemeris.js';
import { createSun, makeNoiseTexture } from './sun.js';
import { makeSurfaceMaterial } from './surface.js';
import { createAtmosphere } from './atmosphere.js';
import { createRings } from './rings.js';
import { loadTex, makeNormalMap } from '../core/textures.js';

const ORBIT_OPACITY = 0.42;

// 最小屏幕半径（CSS 像素）。
// 真实比例下，1 AU 距离时地球只有 0.0004 单位半径——退到 60 AU 就成了亚像素。
// 这里给每个天体一个"可读下限"：只在它小到看不见时才介入，近看时完全不起作用。
// 用户永远不会察觉这条规则，但正是它让"整个太阳系"这一镜成立。
const MIN_PX = { sun: 7.0, planet: 3.0, moon: 1.6 };

// 黄道尘埃光（黄道光）：太阳照亮黄道面上的细尘，形成一层极淡的辉光。
// 它把散落的轨道线"粘"成一个整体，也让全景不再是干巴巴的线框图。
function createEclipticHaze() {
  const geo = new THREE.RingGeometry(0.05, 52, 160, 24);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffd8a6) },
      uGain: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vLoc;
      void main(){ vLoc = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uGain;
      varying vec2 vLoc;
      void main(){
        float r = length(vLoc);
        // 靠近太阳最亮，向外按幂律衰减
        float g = 1.0 / (1.0 + pow(r * 0.92, 1.28));
        g *= smoothstep(0.05, 0.75, r);
        gl_FragColor = vec4(uColor * g * uGain, g * uGain);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -5;
  mesh.name = 'ecliptic-haze';
  return mesh;
}

// 轨道线。
// 平面上的加法线条读起来像一张靶纸——没有前后，就没有纵深。
// 这里按视距做一次衰减：远侧暗下去，近侧亮起来，
// 椭圆立刻变成一条"绕到太阳后面去"的轨道。
function makeOrbitLine(color, opacity = ORBIT_OPACITY) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uNear: { value: 1 },
      uFar: { value: 10 },
    },
    vertexShader: /* glsl */`
      varying float vD;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vD = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uNear;
      uniform float uFar;
      varying float vD;
      void main(){
        float f = 1.0 - smoothstep(uNear, uFar, vD);
        gl_FragColor = vec4(uColor * uOpacity * (0.16 + 0.84 * f), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  return mat;
}

// 远景光点。
// 真实比例下，60 AU 外的地球在屏幕上不到一个像素——它不是"小"，是不存在。
// 最小屏幕半径把它撑到 3px，但那仍然是个黯淡的小球。
// 这里给每颗行星补一层加法辉光：只在它小到只剩几个像素时淡入，
// 于是全景里每一颗行星都是一粒可辨认的星，而不是一串空标签。
function createBodyGlow(count) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const alpha = new Float32Array(count);
  const color = new Float32Array(count * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const mat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      attribute float aSize;
      attribute float aAlpha;
      attribute vec3 aColor;
      varying float vA;
      varying vec3 vC;
      void main(){
        vA = aAlpha; vC = aColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize;
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      varying vec3 vC;
      void main(){
        if (vA < 0.002) discard;
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(q, q);
        if (r2 > 1.0) discard;
        // 核心 + 柔边：看起来像一颗被大气晕开的星
        float g = exp(-r2 * 5.0) + 0.22 * exp(-r2 * 1.4);
        gl_FragColor = vec4(vC * g * vA, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  pts.name = 'body-glow';
  return {
    mesh: pts,
    set(i, x, y, z, px, a, c) {
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      size[i] = px; alpha[i] = a;
      color[i * 3] = c.r; color[i * 3 + 1] = c.g; color[i * 3 + 2] = c.b;
    },
    commit() {
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
      geo.attributes.aColor.needsUpdate = true;
    },
  };
}

export async function buildSystem(scene) {
  const bodies = new Map();
  const sunDir = new THREE.Vector3(1, 0, 0);
  const tmp = new THREE.Vector3();

  // ── 太阳 ──
  const sunRadius = SUN.radius / AU_KM;
  const noiseTex = makeNoiseTexture(256);
  const sunGroup = createSun(sunRadius, noiseTex);
  scene.add(sunGroup);
  bodies.set('sun', {
    id: 'sun', def: SUN, group: sunGroup, radius: sunRadius, isSun: true,
    visualRadius: sunRadius, pos: new THREE.Vector3(),
  });

  // ── 贴图 ──
  // 全部先取低清层（512 宽，13 张合计约 200KB）。
  // 高清由 upgradeRoot() 在首屏出来之后按优先级补。
  const [earthDay, earthNight, earthSpec, earthNorm, earthClouds, moonTex] = await Promise.all([
    loadTex('/tex/earth_day_4096.webp', { lo: true }),
    loadTex('/tex/earth_night_4096.webp', { lo: true }),
    loadTex('/tex/earth_specular_2048.webp', { lo: true }),
    loadTex('/tex/earth_normal_2048.webp', { srgb: false, lo: true }),
    loadTex('/tex/earth_clouds_1024.png', { lo: true }),
    loadTex('/tex/moon_4k.webp', { lo: true }),
  ]);

  const texCache = new Map();
  const loadBodyTex = async (file) => {
    if (!texCache.has(file)) texCache.set(file, await loadTex('/tex/' + file, { lo: true }));
    return texCache.get(file);
  };

  // 岩质天体才做浮雕；气态行星的贴图本身就是云带，再叠法线会变成"脏斑"
  const ROCKY = new Set(['mercury', 'mars']);
  const BUMP = { mercury: 0.55, mars: 0.42, moon: 0.30 };
  // 晨昏线宽度：有大气 → 软；真空 → 刀切
  const TERM = {
    mercury: 0.035, venus: 0.20, earth: 0.085, mars: 0.055,
    jupiter: 0.19, saturn: 0.17, uranus: 0.15, neptune: 0.15, moon: 0.028,
  };
  // 临边昏暗：真空岩质体最强（月面满月时边缘明显发灰），厚大气最弱
  const LIMB = {
    mercury: 0.58, venus: 0.24, earth: 0.19, mars: 0.50,
    jupiter: 0.46, saturn: 0.44, uranus: 0.28, neptune: 0.28, moon: 0.60,
  };
  // 曝光：土星云顶太亮，正照时盘面会被 ACES 压成一片奶白，单给它压一档
  const EXPO = { saturn: 0.76, jupiter: 0.90 };
  const RING_IN = 1.20, RING_OUT = 2.345;

  // ── 行星 ──
  for (const def of PLANETS) {
    const radius = def.radius / AU_KM;
    const group = new THREE.Group();
    group.name = def.id;

    const tilt = new THREE.Group();
    tilt.rotation.z = -def.obliquity * Math.PI / 180;
    group.add(tilt);

    // 土星环要先建：它的径向剖面贴图同时供行星表面的环影采样
    let rings = null;
    let ringTex = null;
    if (def.rings) {
      rings = createRings(radius, { inner: RING_IN, outer: RING_OUT });
      ringTex = rings.userData.material.uniforms.uMap.value;
    }

    let mat;
    if (def.id === 'earth') {
      mat = makeSurfaceMaterial({
        map: earthDay,
        normalMap: earthNorm,
        specMap: earthSpec,
        nightMap: earthNight,
        sunDir,
        bump: 0.55,
        specPow: 6500,
        specGain: 2.1,
        nightGain: 1.05,
        ambient: 0.008,
        atmoColor: 0x4a86e0,
        atmoRim: 0.80,
        exposure: 1.09,
        term: TERM.earth,
        grazing: 0.62,
        limb: LIMB.earth,
      });
    } else {
      const map = await loadBodyTex(def.tex);
      const normal = ROCKY.has(def.id)
        ? await makeNormalMap(map, { width: 1024, strength: 1.25 })
        : null;
      mat = makeSurfaceMaterial({
        map,
        normalMap: normal,
        sunDir,
        bump: BUMP[def.id] ?? 0.4,
        ambient: def.id === 'saturn' ? 0.046 : 0.010,
        atmoColor: def.atmoColor ? new THREE.Color(def.atmoColor) : 0x000000,
        atmoRim: def.atmoColor ? 0.22 : 0.0,
        exposure: EXPO[def.id] ?? 0.86,
        term: TERM[def.id] ?? 0.12,
        grazing: 0.42,
        limb: LIMB[def.id] ?? 0.42,
        ringShadow: def.rings
          ? { normal: new THREE.Vector3(0, 1, 0), inner: radius * RING_IN, outer: radius * RING_OUT, dark: 0.52, map: ringTex }
          : null,
      });
      // 法线是由（低清）反照率实时算的，高清贴图到位后必须重算一遍，
      // 否则整颗星球的浮雕都停在 512 宽的分辨率上。
      if (normal) mat.userData.normalSrc = { width: 1024, strength: 1.25 };
    }

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 160, 120), mat);
    mesh.name = def.id + '-surface';
    tilt.add(mesh);

    // 地球云层
    let clouds = null;
    if (def.id === 'earth' && earthClouds) {
      const cm = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: earthClouds },
          uSunDir: { value: new THREE.Vector3(1, 0, 0) },
          uOpacity: { value: 0.88 },
        },
        vertexShader: /* glsl */`
          varying vec2 vUv; varying vec3 vN; varying vec3 vW;
          void main(){
            vUv = uv;
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vW = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */`
          uniform sampler2D uMap; uniform vec3 uSunDir; uniform float uOpacity;
          varying vec2 vUv; varying vec3 vN; varying vec3 vW;
          void main(){
            vec4 t = texture2D(uMap, vUv);
            vec3 N = normalize(vN);
            // 云壳的轮廓处视线几乎与球面相切，等距柱状贴图会被拉成放射状毛刺
            float limb = smoothstep(0.02, 0.16, dot(N, normalize(cameraPosition - vW)));
            // 极点同样要淡出：UV 压缩把整行云压成一个点，会变成一圈放射状毛刺
            limb *= smoothstep(0.0, 0.055, min(vUv.y, 1.0 - vUv.y));
            float a = t.a * uOpacity * limb;
            if (a < 0.004) discard;
            float ndl = dot(N, normalize(uSunDir));
            float lit = smoothstep(-0.09, 0.20, ndl) * (0.40 + 0.66 * max(ndl, 0.0));
            // 云顶在晨昏线附近偏暖
            vec3 col = vec3(1.0, 0.99, 0.97) * lit;
            float warm = smoothstep(0.0, 0.26, ndl) * (1.0 - smoothstep(0.26, 0.55, ndl));
            col *= mix(vec3(1.0), vec3(1.18, 0.86, 0.66), warm * 0.5);
            gl_FragColor = vec4(col * a, a);
          }`,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      clouds = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.006, 96, 64), cm);
      clouds.renderOrder = 1;
      tilt.add(clouds);
    }

    // 大气
    let atmo = null;
    if (def.atmoColor) {
      atmo = createAtmosphere(radius, {
        color: def.atmoColor,
        sunset: def.id === 'earth' ? 0xff6a32 : 0xffb080,
        intensity: def.id === 'earth' ? 1.35 : (def.atmoStrength ?? 0.42),
        scale: def.id === 'earth' ? 1.052 : 1.020,
        power: def.id === 'earth' ? 3.4 : 3.4,
        sunsetGain: def.id === 'earth' ? 1.0 : 0.5,
      });
      tilt.add(atmo);
    }

    if (rings) tilt.add(rings);

    scene.add(group);
    bodies.set(def.id, {
      id: def.id, def, group, tilt, mesh, clouds, atmo, rings,
      radius, visualRadius: radius, pos: new THREE.Vector3(), mat,
      ringBase: def.rings ? { inner: radius * RING_IN, outer: radius * RING_OUT } : null,
    });
  }

  // ── 月球 ──
  {
    const radius = MOON.radius / AU_KM;
    const group = new THREE.Group();
    group.name = 'moon';
    const tilt = new THREE.Group();
    tilt.rotation.z = -MOON.obliquity * Math.PI / 180;
    group.add(tilt);

    // 法线贴图跟着球面细分一起提：1024 宽在 2.6R 处每个 texel 已经跨好几个像素
    const moonNormal = moonTex ? await makeNormalMap(moonTex, { width: 2048, strength: 1.1 }) : null;
    const mat = makeSurfaceMaterial({
      map: moonTex,
      normalMap: moonNormal,
      sunDir,
      bump: BUMP.moon,
      ambient: 0.010,
      exposure: 1.35,
      term: TERM.moon,
      grazing: 0.30,
      limb: LIMB.moon,
    });
    if (moonNormal) mat.userData.normalSrc = { width: 2048, strength: 1.1 };
    // 月球是全场唯一会被推到 2.6 个半径处的天体，96 段在这个距离下轮廓是多边形
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 160, 120), mat);
    tilt.add(mesh);
    scene.add(group);
    bodies.set('moon', {
      id: 'moon', def: MOON, group, tilt, mesh, radius, visualRadius: radius,
      pos: new THREE.Vector3(), mat,
    });
  }

  // ── 远景光点 ──
  // 光点必须参与深度测试：之前关掉 depthTest，聚焦地球时水星/金星/火星的
  // 光点会浮在地球前面，在北极上方撒出一片粉紫色的脏点。
  // 光点位置沿视线向相机偏移一个半径，这样它不会被自己那颗行星的球面挡住。
  const glow = createBodyGlow(PLANETS.length);
  glow.mesh.material.depthTest = true;
  scene.add(glow.mesh);
  const glowColor = PLANETS.map((d) => new THREE.Color(d.color ?? 0xffffff));

  // ── 轨道线 ──
  const haze = createEclipticHaze();
  scene.add(haze);

  const orbits = new Map();
  const orbitGroup = new THREE.Group();
  orbitGroup.name = 'orbits';
  scene.add(orbitGroup);

  for (const def of PLANETS) {
    const pts = sampleOrbit(def.id, 2460000, def.period, def.id === 'neptune' || def.id === 'uranus' ? 480 : 360);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const mat = makeOrbitLine(def.color);
    const line = new THREE.LineLoop(geo, mat);
    line.frustumCulled = false;
    orbitGroup.add(line);
    orbits.set(def.id, { line, mat, period: def.period });
  }

  // 月球轨道（相对地球）
  {
    const seg = 128;
    const arr = new Float32Array(seg * 3);
    const a = MOON.a / AU_KM;
    for (let i = 0; i < seg; i++) {
      const t = i / seg * Math.PI * 2;
      arr[i * 3] = Math.cos(t) * a;
      arr[i * 3 + 1] = 0;
      arr[i * 3 + 2] = Math.sin(t) * a;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = makeOrbitLine(MOON.color, 0.0);
    const line = new THREE.LineLoop(geo, mat);
    line.frustumCulled = false;
    orbitGroup.add(line);
    orbits.set('moon', { line, mat, moonRing: true });
  }

  // ── 每帧更新 ──
  let lastJd = -1;
  let posCache = null;
  const _ringN = new THREE.Vector3();

  function update(jd, camera, time, viewDist) {
    if (jd !== lastJd) {
      posCache = positionsAt(jd);
      lastJd = jd;
    }
    const P = posCache;

    for (const b of bodies.values()) {
      const p = P[b.id];
      if (!p) continue;
      b.pos.set(p.x, p.y, p.z);
      b.group.position.copy(b.pos);
    }

    // 每像素对应的世界长度（在相机焦点平面上）
    const viewH = camera.userData.viewH || window.innerHeight;
    const camDist = viewDist ?? camera.position.length();

    // 太阳
    const sun = bodies.get('sun');
    sun.group.userData.update(time, camera);
    {
      const d = camera.position.distanceTo(sun.pos);
      const w = 2 * d * Math.tan(camera.fov * Math.PI / 360) / viewH;
      const vis = Math.max(sun.radius, MIN_PX.sun * w);
      const k = vis / sun.radius;
      sun.group.scale.setScalar(k);
      sun.visualRadius = vis;
      // 屏幕上不足 ~5px 时关掉临边昏暗与米粒，否则会变成一圈红边
      const detail = smooth(4.0, 42.0, vis / w);
      sun.group.getObjectByName('photosphere').material.uniforms.uDetail.value = detail;
      sun.group.getObjectByName('corona').material.uniforms.uPoint.value = 1 - detail;
    }

    // 行星
    for (const def of PLANETS) {
      const b = bodies.get(def.id);
      const dir = tmp.copy(b.pos).negate().normalize();
      b.mat.uniforms.uSunDir.value.copy(dir);
      if (b.atmo) b.atmo.userData.setSunDir(dir);

      // 最小屏幕尺寸
      const d = camera.position.distanceTo(b.pos);
      const w = 2 * d * Math.tan(camera.fov * Math.PI / 360) / viewH;
      const vis = Math.max(b.radius, MIN_PX.planet * w);
      const k = vis / b.radius;
      if (Math.abs(k - b.group.scale.x) > 1e-6) b.group.scale.setScalar(k);
      b.visualRadius = vis;

      const spin = spinAngle(def.rotationDays, jd);
      b.mesh.rotation.y = spin;
      if (b.clouds) {
        b.clouds.rotation.y = spin * 1.035 + 0.4;
        b.clouds.material.uniforms.uSunDir.value.copy(dir);
      }
      if (b.rings) {
        const rm = b.rings.userData.material.uniforms;
        rm.uSunDir.value.copy(dir);
        rm.uCenter.value.copy(b.pos);
        rm.uPlanetRadius.value = b.radius * k;
      }
      if (b.mat.uniforms.uRingCenter && b.ringBase) {
        b.mat.uniforms.uRingCenter.value.copy(b.pos);
        b.mat.uniforms.uRingInner.value = b.ringBase.inner * k;
        b.mat.uniforms.uRingOuter.value = b.ringBase.outer * k;
        // 环面法线要转到世界系，否则阴影方向会随轴倾角跑偏
        _ringN.set(0, 1, 0).applyQuaternion(b.tilt.quaternion);
        b.mat.uniforms.uRingNormal.value.copy(_ringN);
      }
    }

    // 远景光点：行星小到只剩几个像素时淡入
    {
      const pr = camera.userData.px || 1;
      for (let i = 0; i < PLANETS.length; i++) {
        const b = bodies.get(PLANETS[i].id);
        const d = camera.position.distanceTo(b.pos);
        const wpx = 2 * d * Math.tan(camera.fov * Math.PI / 360) / viewH;
        const rpx = b.visualRadius / wpx;
        const a = (1 - smooth(4.5, 15, rpx)) * 0.95;
        const off = b.visualRadius * 1.35;
        const k = off / Math.max(d, 1e-12);
        glow.set(i,
          b.pos.x + (camera.position.x - b.pos.x) * k,
          b.pos.y + (camera.position.y - b.pos.y) * k,
          b.pos.z + (camera.position.z - b.pos.z) * k,
          Math.max(9, rpx * 3.0) * pr, a, glowColor[i]);
      }
      glow.commit();
    }

    // 月球：潮汐锁定，正面朝地球
    const moon = bodies.get('moon');
    const earth = bodies.get('earth');
    const md = tmp.copy(earth.pos).sub(moon.pos);
    const moonDir = tmp.copy(moon.pos).negate().normalize();
    moon.mat.uniforms.uSunDir.value.copy(moonDir);
    moon.mesh.rotation.y = Math.atan2(-md.z, md.x);
    moon.group.rotation.y = 0;
    {
      const d = camera.position.distanceTo(moon.pos);
      const w = 2 * d * Math.tan(camera.fov * Math.PI / 360) / viewH;
      const vis = Math.max(moon.radius, MIN_PX.moon * w);
      const k = vis / moon.radius;
      if (Math.abs(k - moon.group.scale.x) > 1e-6) moon.group.scale.setScalar(k);
      moon.visualRadius = vis;
    }

    // 月球轨道线跟随地球
    const mo = orbits.get('moon');
    mo.line.position.copy(earth.pos);

    // 黄道光只在远景出现；贴近时那层平面会糊满屏幕
    haze.material.uniforms.uGain.value = 0.20 * smooth(4, 26, camDist);

    // 轨道线：贴近天体时淡出（否则会横穿画面、压在地球上）
    for (const [id, o] of orbits) {
      let op;
      if (o.moonRing) {
        // 用"相机到焦点"的距离而不是"到地球"的距离：
        // 聚焦月球时相机离地球仍是 0.0026 AU，旧判据算出 op=0.31，
        // 于是一条月球轨道斜穿整个画面。
        op = 0.34 * (1 - smooth(0.0016, 0.0075, camDist)) * smooth(0.00025, 0.0006, camDist);
      } else {
        op = ORBIT_OPACITY * smooth(0.012, 0.42, camDist);
      }
      o.mat.uniforms.uOpacity.value = op;
      o.mat.uniforms.uNear.value = camDist * 0.50;
      o.mat.uniforms.uFar.value = camDist * 1.45;
      o.line.visible = op > 0.0015;
    }
  }

  function smooth(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  return { bodies, orbits, orbitGroup, update, getPositions: () => posCache };
}
