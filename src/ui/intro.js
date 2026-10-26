// 开场：地球近景（晨昏线）→ 黑场 → 整个太阳系
import * as THREE from 'three';

const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const _camDir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _screenUp = new THREE.Vector3();

export class Intro {
  constructor({ rig, camera, getPos }) {
    this.rig = rig;
    this.camera = camera;
    this.getPos = getPos;
    this.el = document.getElementById('intro');
    this.veil = document.getElementById('veil');

    this.active = false;
    this.frozen = false;
    this.done = false;
    this.t = 0;

    // 时间轴
    this.T = {
      veilIn: [0.0, 1.35],      // 黑 → 画面
      titleOut: 2.45,
      veilOut: [2.95, 3.42],    // 画面 → 黑
      cut: 3.42,
      veilIn2: [3.42, 4.20],    // 黑 → 画面
      pull: [4.20, 10.4],
      end: 10.7,
    };

    this._shotA = null;
    this._shotB = null;
    this.onDone = null;
    this.onStage = null;
  }

  begin() {
    this.active = true;
    this.t = 0;
    this.done = false;

    const earth = this.getPos('earth');
    const R = 6371 / 149597870.7;

    // 相位角 100°：晨昏线斜穿画面，一半白昼一半夜
    const toSun = earth.clone().normalize().negate();
    const dir = toSun.clone().applyAxisAngle(_up, 100 * Math.PI / 180);
    dir.y = 0.17;
    dir.normalize();

    // 竖屏（手机）不能照搬横屏构图：地球会撑满整屏并压住标题。
    // 竖屏改成"地球缩到上半部、标题落在底部"。
    const portrait = (this.camera.aspect || 1.6) < 0.85;

    this._shotA = {
      target: earth.clone(),
      d0: R * (portrait ? 5.6 : 3.75),
      d1: R * (portrait ? 6.3 : 4.55),
      theta: Math.atan2(dir.z, dir.x),
      phi: Math.acos(Math.max(-1, Math.min(1, dir.y))),
      // 横屏：地球推到画面右侧，左半屏留给标题
      shift: portrait ? 0 : 0.34,
      lift: portrait ? 0.26 : 0,
    };
    this._shotB = {
      d0: 18,
      d1: 74,
      theta: this._shotA.theta + 0.62,
      phi0: 0.90,
      phi1: 1.00,
    };

    this._applyShotA(0);
    if (this.el) this.el.classList.add('is-on');
    if (this.veil) this.veil.style.opacity = '1';
    if (this.onStage) this.onStage('a');
  }

  /** 把视点侧移/下移，让地球落在画面右侧（横屏）或上半部（竖屏） */
  _offsetTarget(target, phi, theta, shift, lift = 0) {
    const aspect = this.camera.aspect || 1.6;
    const halfW = this.rig.distance * Math.tan(this.camera.fov * Math.PI / 360) * aspect;
    const halfH = this.rig.distance * Math.tan(this.camera.fov * Math.PI / 360);
    _camDir.set(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta),
    );
    _fwd.copy(_camDir).negate();
    _right.crossVectors(_fwd, _up);
    if (_right.lengthSq() < 1e-9) _right.set(1, 0, 0);
    _right.normalize();
    // 屏幕上方 = right × forward
    _screenUp.crossVectors(_right, _fwd).normalize();
    const out = target.clone().addScaledVector(_right, -shift * halfW);
    if (lift) out.addScaledVector(_screenUp, -lift * halfH);
    return out;
  }

  _applyShotA(e) {
    const a = this._shotA;
    const rig = this.rig;
    rig.distance = a.d0 + (a.d1 - a.d0) * e;
    rig.targetDistance = rig.distance;
    rig.theta = a.theta + e * 0.055;
    rig.phi = a.phi - e * 0.022;
    rig.target.copy(this._offsetTarget(a.target, rig.phi, rig.theta, a.shift, a.lift));
    rig.followId = null;
    rig._prevAnchor = a.target.clone();
    rig._apply(0);
  }

  _applyShotB(e) {
    const b = this._shotB;
    const rig = this.rig;
    rig.target.set(0, 0, 0);
    rig.distance = b.d0 * Math.pow(b.d1 / b.d0, e);
    rig.targetDistance = rig.distance;
    rig.theta = b.theta;
    rig.phi = b.phi0 + (b.phi1 - b.phi0) * e;
    rig.followId = 'sun';
    rig._prevAnchor = new THREE.Vector3();
    rig._apply(0);
  }

  update(dt) {
    if (!this.active || this.frozen) return;
    this.t += dt;
    const T = this.T, t = this.t;

    // 遮罩
    if (this.veil) {
      let o = 0;
      if (t < T.veilIn[1]) o = 1 - smooth(T.veilIn[0], T.veilIn[1], t);
      else if (t >= T.veilOut[0] && t < T.cut) o = smooth(T.veilOut[0], T.veilOut[1], t);
      else if (t >= T.cut && t < T.veilIn2[1]) o = 1 - smooth(T.veilIn2[0], T.veilIn2[1], t);
      this.veil.style.opacity = o.toFixed(3);
    }

    if (this.el && t >= T.titleOut) this.el.classList.add('is-out');

    if (t < T.cut) {
      this._applyShotA(smooth(0, T.cut, t));
    } else {
      const e = smooth(T.pull[0], T.pull[1], t);
      this._applyShotB(easeInOut(e));
    }

    if (t >= T.end) this.finish();
  }

  finish() {
    if (this.done) return;
    this.done = true;
    this.active = false;
    if (this.veil) this.veil.style.opacity = '0';
    this.rig.target.set(0, 0, 0);
    this.rig.distance = this._shotB.d1;
    this.rig.targetDistance = this._shotB.d1;
    this.rig.theta = this._shotB.theta;
    this.rig.phi = this._shotB.phi1;
    this.rig.followId = 'sun';
    this.rig._prevAnchor = new THREE.Vector3();
    if (this.el) this.el.classList.add('is-out');
    if (this.onDone) this.onDone();
  }

  skip() {
    if (!this.active) return;
    this.t = this.T.end;
    this.finish();
  }

  /** 调试：定格到某一时刻 */
  renderAt(t) {
    this.t = t;
    if (t < this.T.cut) this._applyShotA(smooth(0, this.T.cut, t));
    else this._applyShotB(easeInOut(smooth(this.T.pull[0], this.T.pull[1], t)));
    if (this.veil) this.veil.style.opacity = '0';
    if (this.el) {
      this.el.classList.add('is-static');
      this.el.classList.remove('is-on', 'is-out');
      this.el.classList.add(t >= this.T.titleOut ? 'is-out' : 'is-on');
    }
  }
}
