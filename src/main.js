// 巡天 · 太阳系
import * as THREE from 'three';
import './style.css';
import { createRenderer, createComposer } from './core/renderer.js';
import { bakeGalaxy, createStars } from './core/sky.js';
import { buildSystem } from './scene/system.js';
import { Rig, MIN_DIST } from './core/camera.js';
import { Clock } from './core/clock.js';
import { Labels } from './ui/labels.js';
import { Panel } from './ui/panel.js';
import { Timebar } from './ui/timebar.js';
import { Intro } from './ui/intro.js';
import { BY_ID } from './data/bodies.js';

const canvas = document.getElementById('gl');
const loader = document.getElementById('loader');
const loaderFill = document.getElementById('loader-fill');
const loaderNote = document.getElementById('loader-note');
const ui = document.getElementById('ui');
const hint = document.getElementById('hint');

const renderer = createRenderer(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1e-6, 20000);
camera.userData.viewH = window.innerHeight;
camera.userData.px = Math.min(window.devicePixelRatio || 1, 1.6);

let system = null;
let rig = null;
let composer = null;
let labels = null;
let panel = null;
let timebar = null;
let intro = null;
let stars = null;
const clock = new Clock();

const state = {
  focusId: 'sun',
  ready: false,
  hiddenUI: false,
  lastPointer: { x: 0, y: 0 },
  hovered: null,
};

// ───────────────────────── 启动 ─────────────────────────

async function boot() {
  // 银河背景 + 星场
  scene.background = bakeGalaxy(renderer);
  scene.backgroundIntensity = 1.0;
  stars = createStars(11000, 6000);
  scene.add(stars);

  setProgress(0.12, '正在点亮太阳');

  system = await buildSystem(scene);
  setProgress(0.72, '正在安置行星');

  labels = new Labels(document.getElementById('labels'));
  labels.setBodies([...system.bodies.values()]);

  rig = new Rig(camera, canvas);
  rig.getPos = (id) => system.bodies.get(id)?.pos;
  rig.followId = 'sun';

  const fx = createComposer(renderer, scene, camera);
  composer = fx.composer;
  state.bloom = fx.bloom;
  state.grade = fx.grade;
  state.bloomScale = fx.bloomScale;

  panel = new Panel(() => { state.focusId = null; });
  timebar = new Timebar({ clock, onChange: () => {} });

  intro = new Intro({
    rig,
    camera,
    getPos: (id) => system.bodies.get(id).pos.clone(),
  });
  intro.onDone = () => {
    ui.classList.add('is-live');
    clock.play();
    timebar._syncPlay();
    setTimeout(() => hint.classList.remove('is-hidden'), 900);
    setTimeout(() => hint.classList.add('is-hidden'), 11000);
  };

  // 先算一帧，确保贴图都已上传
  system.update(clock.jd, camera, 0);
  rig.update(0, (id) => system.bodies.get(id)?.pos);

  setProgress(1, '');
  await nextFrame();
  await nextFrame();
  loader.classList.add('is-gone');
  setTimeout(() => { loader.style.display = 'none'; }, 1200);

  state.ready = true;
  intro.begin();
  clock.pause();

  bindInteraction();
  loop();
}

function nextFrame() {
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

function setProgress(p, note) {
  loaderFill.style.width = `${Math.min(100, p * 100)}%`;
  if (note) loaderNote.textContent = note;
}

// ───────────────────────── 交互 ─────────────────────────

const _v = new THREE.Vector3();

function projectToScreen(pos, out) {
  _v.copy(pos).project(camera);
  out.x = (_v.x * 0.5 + 0.5) * window.innerWidth;
  out.y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
  out.behind = _v.z > 1;
  return out;
}

function pickAt(x, y, threshold = 46) {
  if (!system) return null;
  const p = { x: 0, y: 0, behind: false };
  let best = null, bestD = Infinity;
  for (const b of system.bodies.values()) {
    projectToScreen(b.pos, p);
    if (p.behind) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    const dist3 = camera.position.distanceTo(b.pos);
    const pxPerUnit = window.innerHeight / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.max(dist3, 1e-9));
    const rpx = (b.visualRadius ?? b.radius) * pxPerUnit;
    const tol = Math.max(threshold, Math.min(120, rpx * 1.1));
    if (d < tol && d < bestD) { bestD = d; best = b; }
  }
  return best;
}

function focusBody(b, dur = 1.5) {
  if (!b) return;
  state.focusId = b.id;
  const isSun = b.id === 'sun';
  const portrait = window.innerWidth <= 860;
  const GAS = { jupiter: 5.4, saturn: 5.8, uranus: 6.2, neptune: 6.2 };
  const mult = isSun ? 5.2 : (b.id === 'moon' ? 7.0 : (GAS[b.id] ?? 6.6));
  let dist = b.radius * mult;
  if (portrait) {
    // 竖屏横向视野只有 ~11°，同样的距离会把天体撑满整宽 → 退远一点。
    // 有环天体还要按环的外缘算：土星环半径是行星的 2.345 倍，
    // 按行星半径摆机位的结果是环整个溢出画面。
    const hHalf = Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect);
    const extent = b.ringBase ? b.ringBase.outer : b.radius;
    dist = Math.max(dist * 1.34, extent / Math.tan(hHalf * 0.92));
  }

  // 机位落在受光侧偏一个相位角：既看得见昼夜分界，又不会让主体陷进暗部。
  // 气态行星偏小一点（40°），否则大半个盘面都是黑的；月球偏大（72°）看月牙。
  const PHASE = {
    mercury: 1.00, venus: 1.02, earth: 1.08, mars: 0.96,
    jupiter: 0.58, saturn: 0.46, uranus: 0.66, neptune: 0.66, moon: 1.26,
  };
  const s = b.pos.clone().negate();
  if (s.lengthSq() < 1e-12) s.set(0, 0, 1);
  s.normalize();
  const up = new THREE.Vector3(0, 1, 0);
  let axis = new THREE.Vector3().crossVectors(s, up);
  if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
  axis.normalize();
  const camDir = s.clone().applyAxisAngle(axis, PHASE[b.id] ?? 1.0).normalize();

  // 抬高机位仰角：土星环几乎躺在黄道面上，不抬就永远是"一条线"
  const ELEV = { earth: 0.16, mars: 0.14, saturn: 0.46, jupiter: 0.10, uranus: 0.32, neptune: 0.32 };
  const elev = ELEV[b.id] || 0;
  if (elev > 0) {
    const horiz = new THREE.Vector3(camDir.x, 0, camDir.z);
    if (horiz.lengthSq() > 1e-9) {
      horiz.normalize();
      const tiltAxis = new THREE.Vector3().crossVectors(horiz, up).normalize();
      camDir.applyAxisAngle(tiltAxis, elev).normalize();
    }
  }

  // 有环的天体不能按黄道仰角摆机位。
  // 土星环面与黄道成 26.7°，太阳此刻在环面下方 23.7°——
  // 只要相机落在环面之上，看到的就是被环影盖住的极冠，
  // 整个北半球糊成一张等高线图。所以这里改成相对环面定位：
  // 从受光那一侧、低仰角看过去，环是开的，行星是亮的。
  if (b.tilt && b.ringBase) {
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(b.tilt.quaternion).normalize();
    const sAz = s.clone().addScaledVector(n, -s.dot(n));
    if (sAz.lengthSq() > 1e-9) {
      sAz.normalize();
      const side = new THREE.Vector3().crossVectors(n, sAz).normalize();
      const e = -0.36, p = 0.44;
      camDir.copy(sAz).multiplyScalar(Math.cos(e) * Math.cos(p))
        .addScaledVector(side, Math.cos(e) * Math.sin(p))
        .addScaledVector(n, Math.sin(e)).normalize();
    }
  }

  const phi = Math.acos(Math.max(-1, Math.min(1, camDir.y)));
  const theta = Math.atan2(camDir.z, camDir.x);

  // 竖屏时面板是底部抽屉，主体要抬到画面上半部，否则会被抽屉盖住
  let offset = null;
  if (portrait) {
    const upS = new THREE.Vector3(0, 1, 0).addScaledVector(camDir, -camDir.y);
    if (upS.lengthSq() > 1e-9) {
      upS.normalize();
      const halfH = dist * Math.tan(camera.fov * Math.PI / 360);
      offset = upS.multiplyScalar(-0.44 * halfH);
    }
  }

  // 最近可推到 2.6 个天体半径：再近，贴图分辨率跟不上，
  // 法线贴图的屏幕导数也会开始打架，画面会糊成一片并在静止时微颤。
  rig.minDist = b.radius * 2.6;
  rig.flyTo(b.id, b.pos, { dist, theta, phi, dur, offset });
  setView(null);
  panel.show(b.def, isSun ? '00' : String(idxOf(b.id)).padStart(2, '0'));
}

function idxOf(id) {
  const order = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon'];
  const i = order.indexOf(id);
  return i < 0 ? 0 : i + 1;
}

// ── 视角切换 ──
// 全景里水星到火星的轨道半径分别是 2.8px / 5.5px / 8.5px / 11px，
// 全部落在太阳 7px 的光晕里，四颗行星的可点击区域完全重叠——
// 点谁都可能点到别的那颗，这不是热区太小的问题，是尺度本身的问题。
// 内太阳系把这个范围放大 20 倍：水星 108px，火星 425px。
const VIEWS = {
  wide: () => rig.overview(),
  inner: () => {
    panel.hide();
    state.focusId = 'sun';
    rig.minDist = 0;
    rig.flyTo('sun', new THREE.Vector3(), { dist: 4.2, theta: rig.theta, phi: 0.62, dur: 2.0 });
  },
};

let viewBtns = [];
function setView(name) {
  for (const b of viewBtns) b.classList.toggle('is-on', b.dataset.view === name);
}

function bindInteraction() {
  // 沉浸模式
  const immersive = document.getElementById('immersive');
  immersive.addEventListener('click', () => {
    state.hiddenUI = !state.hiddenUI;
    document.body.classList.toggle('is-hidden-ui', state.hiddenUI);
  });

  // 视角
  viewBtns = [...document.querySelectorAll('#views button')];
  for (const b of viewBtns) {
    b.addEventListener('click', () => {
      const fn = VIEWS[b.dataset.view];
      if (!fn) return;
      fn();
      setView(b.dataset.view);
    });
  }

  // 点击拾取
  let downX = 0, downY = 0, downT = 0;
  canvas.addEventListener('pointerdown', (e) => {
    downX = e.clientX; downY = e.clientY; downT = performance.now();
    if (intro.active) intro.skip();
    hint.classList.add('is-hidden');
  });
  canvas.addEventListener('pointerup', (e) => {
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    const dt = performance.now() - downT;
    if (moved > 7 || dt > 700) return;
    const b = pickAt(e.clientX, e.clientY);
    if (b) focusBody(b);
    else {
      panel.hide();
      state.focusId = null;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const b = pickAt(e.clientX, e.clientY, 26);
    const want = b ? 'pointer' : 'grab';
    if (canvas.style.cursor !== want) canvas.style.cursor = want;
  });

  canvas.addEventListener('wheel', () => {
    if (intro.active) intro.skip();
    hint.classList.add('is-hidden');
    panel.hide();
    state.focusId = null;
  }, { passive: true });

  // 键盘
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        clock.toggle();
        timebar._syncPlay();
        break;
      case 'KeyH':
        state.hiddenUI = !state.hiddenUI;
        document.body.classList.toggle('is-hidden-ui', state.hiddenUI);
        break;
      case 'KeyR':
        rig.overview();
        panel.hide();
        state.focusId = 'sun';
        setView('wide');
        break;
      case 'KeyI':
        VIEWS.inner();
        setView('inner');
        break;
      case 'Escape':
        panel.hide();
        state.focusId = null;
        break;
      case 'BracketLeft': clock.setRate(clock.rateIndex - 1); break;
      case 'BracketRight': clock.setRate(clock.rateIndex + 1); break;
      default:
        if (e.code === 'KeyM') { const b = system.bodies.get('moon'); if (b) focusBody(b); }
        else if (e.code.startsWith('Digit')) {
          const i = +e.code.slice(5);
          const order = ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
          if (i < order.length) {
            const b = system.bodies.get(order[i]);
            if (b) focusBody(b);
          }
        }
    }
  });

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.userData.viewH = h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  if (composer) {
    composer.setSize(w, h);
    const pr = renderer.getPixelRatio();
    const bs = state.bloomScale ?? 0.5;
    state.bloom?.setSize(w * bs, h * bs);
    state.grade?.uniforms.uRes.value.set(w * pr, h * pr);
  }
}

// ───────────────────────── 主循环 ─────────────────────────

let last = performance.now();
let elapsed = 0;

function loop() {
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05);
  elapsed += dt;

  if (!state.ready) { requestAnimationFrame(loop); return; }

  clock.tick(dt);
  system.update(clock.jd, camera, elapsed, rig.distance);

  if (intro.active) intro.update(dt);
  else rig.update(dt, (id) => system.bodies.get(id)?.pos);

  // 星场跟随相机，消除视差
  stars.position.copy(camera.position);

  // 银河随相机距离压暗：聚焦天体时主体是画面里唯一该被看见的东西。
  // 全景时 1.0（银河完整），贴到某个天体上时压到 0.28——
  // 这是摄影里最基本的取舍，主体亮起来，背景就必须退下去。
  {
    // 曲线拉陡：内太阳系（3.9 AU）只给 0.4，全景（62 AU）才给满。
    // 否则那团银河在轨道图上看起来像一层蓝灰色的烟。
    const d = rig.distance;
    const t = Math.min(1, Math.max(0, (d - 1.5) / (12 - 1.5)));
    scene.backgroundIntensity = 0.18 + 0.82 * (t * t * (3 - 2 * t));
  }

  // 相机移动时关闭面板（避免面板遮挡正在看的东西）
  labels.update(camera, system.bodies, {
    width: window.innerWidth,
    height: window.innerHeight,
    focusId: state.focusId,
    hidden: state.hiddenUI || (intro && !intro.done),
  });

  timebar.update();

  composer.render(dt);

  requestAnimationFrame(loop);
}

boot().catch(err => {
  console.error(err);
  loaderNote.textContent = '启动失败：' + (err && err.message || err);
});

// 调试接口
window.__SYS = {
  get scene() { return scene; },
  get camera() { return camera; },
  get rig() { return rig; },
  get system() { return system; },
  clock,
  get intro() { return intro; },
  focus: (id) => focusBody(system.bodies.get(id)),
  freezeIntro(t) { intro.frozen = true; intro.renderAt(t); },
  THREE,
};
