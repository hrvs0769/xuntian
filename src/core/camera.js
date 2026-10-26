// 相机：连续对数缩放 + 阻尼环绕 + 平滑飞向天体 + 跟随
import * as THREE from 'three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export const MIN_DIST = 2e-5;    // AU（约 3000 km）
export const MAX_DIST = 120;     // AU

export class Rig {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;

    this.target = new THREE.Vector3();
    this.distance = 60;
    this.targetDistance = 60;
    this.theta = 0.6;
    this.phi = 1.05;

    this.followId = null;
    this.getPos = () => new THREE.Vector3();
    // 聚焦天体的固定屏幕偏移（竖屏时把主体抬到画面上半部）
    this._followOffset = new THREE.Vector3();
    // 最近距离下限，按被观测天体的半径设定；0 表示用全局 MIN_DIST
    this.minDist = 0;

    this.thetaVel = 0;
    this.phiVel = 0;

    this._fly = null;
    this._pointers = new Map();
    this._lastPinch = 0;
    this._dragging = false;
    this._moved = 0;
    this._lastInteract = performance.now();

    this.onInteract = null;

    this._bind();
    this._apply(0);
  }

  _bind() {
    const el = this.dom;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button > 0) return;
      el.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._dragging = true;
      this._moved = 0;
      this._fly = null;
      this.thetaVel = 0; this.phiVel = 0;
      this._lastInteract = performance.now();
    });

    el.addEventListener('pointermove', (e) => {
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;

      if (this._pointers.size === 1) {
        const k = 0.0042 * Math.min(1.4, 900 / Math.max(500, el.clientHeight));
        this.theta -= dx * k;
        this.phi = clamp(this.phi - dy * k, 0.08, Math.PI - 0.08);
        this.thetaVel = -dx * k;
        this.phiVel = -dy * k;
        this._moved += Math.abs(dx) + Math.abs(dy);
      } else if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this._lastPinch > 0) {
          const f = this._lastPinch / d;
          this.zoomBy(f);
        }
        this._lastPinch = d;
        this._moved += 10;
      }
      this._lastInteract = performance.now();
      if (this.onInteract) this.onInteract();
    });

    const end = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._lastPinch = 0;
      if (this._pointers.size === 0) this._dragging = false;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dy = e.deltaY * unit;
      this.zoomBy(Math.exp(dy * 0.0011));
      this._lastInteract = performance.now();
      if (this.onInteract) this.onInteract();
    }, { passive: false });

    // 双击 = 回到全景
    el.addEventListener('dblclick', () => this.overview());
  }

  zoomBy(f) {
    // 最近距离要按被观测天体的半径算，而不是一个全局常数。
    // 全局 2e-5 AU 对木星是"还隔着一个木星"，对月球却是"贴到脸上"——
    // 相机距月心 1.89 个半径时，4K 贴图被放大三倍，法线贴图的采样也开始打架，
    // 画面糊成一片并且随视角微颤。2.6 个半径是贴图分辨率与压迫感的平衡点。
    const lo = Math.max(MIN_DIST, this.minDist || 0);
    this.targetDistance = clamp(this.targetDistance * f, lo, MAX_DIST);
    if (this._fly) { this._fly = null; this._prevAnchor = null; }
  }

  /** 飞向天体 */
  flyTo(id, pos, { dist, theta, phi, dur = 1.5, offset = null } = {}) {
    const r = pos.length();
    const d = dist ?? Math.max(pos.length() * 0.0001, 0.0002);
    const from = {
      t: this.target.clone(),
      d: this.distance,
      th: this.theta,
      ph: this.phi,
    };
    let th = theta;
    if (th === undefined) {
      // 保持当前方位，但避免正对太阳（逆光）
      th = this.theta;
      if (r > 1e-6) {
        const sunAng = Math.atan2(-pos.z, -pos.x);
        const diff = Math.atan2(Math.sin(th - sunAng), Math.cos(th - sunAng));
        if (Math.abs(diff) < 0.5) th = sunAng + 0.85;
      }
    }
    const to = {
      t: pos.clone(),
      d: clamp(d, Math.max(MIN_DIST, this.minDist || 0), MAX_DIST),
      th,
      ph: phi ?? clamp(this.phi, 0.35, Math.PI - 0.35),
    };
    // offset 让主体偏离画面中心（竖屏时避开底部抽屉）
    this._fly = { from, to, t: 0, dur, id, offset: offset ? offset.clone() : null };
    this._followOffset = offset ? offset.clone() : new THREE.Vector3();
    this.followId = id;
    this._prevAnchor = null;
  }

  overview() {
    this.minDist = 0;
    this.flyTo('sun', new THREE.Vector3(), { dist: 62, theta: this.theta, phi: 0.98, dur: 1.8 });
  }

  update(dt, bodyPositions) {
    const getP = (id) => (bodyPositions && id) ? bodyPositions(id) : null;

    if (this._fly) {
      const f = this._fly;
      // 飞行途中目标跟着天体实时走，否则时间推进时会被甩开
      const p = getP(f.id);
      if (p) { f.to.t.copy(p); if (f.offset) f.to.t.add(f.offset); }

      f.t += dt / f.dur;
      const e = easeInOut(clamp(f.t, 0, 1));
      this.target.lerpVectors(f.from.t, f.to.t, e);
      this.distance = f.from.d + (f.to.d - f.from.d) * e;
      this.targetDistance = this.distance;
      this.theta = f.from.th + (f.to.th - f.from.th) * e;
      this.phi = f.from.ph + (f.to.ph - f.from.ph) * e;

      if (f.t >= 1) {
        this._fly = null;
        // 飞行终点精确落到天体上：lerp 的最后一帧与真实位置总差一点点，
        // 不在这里对齐，切到刚性跟随的那一帧会有一次亚像素的弹跳。
        if (p) { this.target.copy(p).add(this._followOffset); this._prevAnchor = p.clone(); }
        this._apply(0);
        return;
      }
    } else {
      // 刚性跟随。
      // 原来是"每帧加上天体位移的增量"——理论上等价，实际有两个问题：
      // 一是增量依赖 dt，掉一帧就会多走一截，画面在近距观察时有细微的顿挫；
      // 二是误差会一路累加下去。
      // 直接写成 target = 天体位置 + 固定偏移，天体就钉死在画面上，只剩背景在动。
      const p = getP(this.followId);
      if (p) this.target.copy(p).add(this._followOffset);

      // 缩放平滑
      const zk = 1 - Math.exp(-dt * 9);
      this.distance += (this.targetDistance - this.distance) * zk;

      // 惯性
      if (!this._dragging) {
        this.theta += this.thetaVel * dt * 60 * 0.55;
        this.phi = clamp(this.phi + this.phiVel * dt * 60 * 0.55, 0.08, Math.PI - 0.08);
        const decay = Math.exp(-dt * 4.2);
        this.thetaVel *= decay;
        this.phiVel *= decay;
      }
    }

    this._apply(dt);
  }

  _apply(dt) {
    const cam = this.camera;
    const d = this.distance;
    const sp = Math.sin(this.phi);
    const x = this.target.x + d * sp * Math.cos(this.theta);
    const y = this.target.y + d * Math.cos(this.phi);
    const z = this.target.z + d * sp * Math.sin(this.theta);
    cam.position.set(x, y, z);
    cam.lookAt(this.target);

    // 不用对数深度：所有材质（含自定义着色器）走同一套标准深度，
    // 靠收紧 near 保证精度（近平面 0.05d，正好在被观测天体之外）。
    const near = Math.max(1e-9, d * 0.05);
    const far = Math.max(7000, d * 30);
    if (Math.abs(cam.near - near) / cam.near > 0.05 || Math.abs(cam.far - far) / cam.far > 0.05) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  }

  /** 当前视点对应的屏幕像素/弧度量 */
  pxPerUnit(heightPx) {
    return heightPx / (2 * Math.tan(this.camera.fov * Math.PI / 360) * this.distance);
  }
}
