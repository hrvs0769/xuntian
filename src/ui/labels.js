// 天体标签：把世界坐标投影到屏幕，带遮挡避让与远近淡出
import * as THREE from 'three';

const _v = new THREE.Vector3();

export class Labels {
  constructor(container) {
    this.el = container;
    this.items = new Map();
  }

  setBodies(list) {
    this.el.innerHTML = '';
    this.items.clear();
    for (const b of list) {
      const el = document.createElement('div');
      el.className = 'lbl' + (b.id === 'sun' ? ' is-major' : '');
      el.style.color = b.def.color;
      el.innerHTML =
        `<span class="lbl-dot"></span>` +
        `<span class="lbl-text">${b.def.name}</span>` +
        `<span class="lbl-en">${b.def.en}</span>`;
      // 初始必须自己藏起来。
      // .lbl 在 CSS 里是 left:0;top:0 + translate(-50%,-50%)，
      // 第一帧若被判为"画外"而跳过 transform 赋值，它就会永远停在左上角，
      // 露出半截英文名——这就是之前那个幽灵标签。
      el.style.opacity = '0';
      el.style.display = 'none';
      this.el.appendChild(el);
      this.items.set(b.id, { el, body: b, visible: true, alpha: 0 });
    }
  }

  update(camera, bodies, { width, height, focusId, panelOpen, hidden }) {
    const placed = [];
    const halfW = width / 2, halfH = height / 2;

    // 太阳优先，其次按距相机由近到远
    const order = [...this.items.values()].sort((a, b) => {
      if (a.body.id === 'sun') return -1;
      if (b.body.id === 'sun') return 1;
      const da = camera.position.distanceTo(a.body.pos);
      const db = camera.position.distanceTo(b.body.pos);
      return da - db;
    });

    for (const item of order) {
      const { el, body } = item;
      const p = body.pos;

      _v.copy(p).project(camera);
      const behind = _v.z > 1 || _v.z < -1;
      const sx = (_v.x * 0.5 + 0.5) * width;
      const sy = (-_v.y * 0.5 + 0.5) * height;

      // 天体屏幕半径
      const dist = camera.position.distanceTo(p);
      const pxPerUnit = height / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.max(dist, 1e-9));
      const rpx = body.radius * pxPerUnit;

      // 标签落点：天体右上方，随半径外推
      const off = Math.min(120, rpx) * 0.72 + 10;
      const tx = sx + off * 0.82;
      const ty = sy - off * 0.62;

      // 裁切必须按"标签自己的位置"判断，而不是天体中心：
      // 天体贴边时 off 会把它推到画外，结果是半截英文名挂在角上。
      if (behind || tx < 18 || tx > width - 132 || ty < 22 || ty > height - 72) {
        item.alpha = 0;
        el.style.opacity = '0';
        el.style.display = 'none';
        continue;
      }

      // 太近（天体占满画面）时标签退场
      let a = 1 - smooth(0.24 * height, 0.44 * height, rpx);
      // 选中的天体标签隐藏（面板已显示名字）
      if (body.id === focusId) a *= 0.0;
      if (hidden) a = 0;


      // 避让
      const box = { x: sx - 26, y: sy - 10, w: 96, h: 22 };
      if (a > 0.02) {
        for (const q of placed) {
          if (box.x < q.x + q.w && box.x + box.w > q.x && box.y < q.y + q.h && box.y + box.h > q.y) {
            a *= 0.0; break;
          }
        }
      }
      if (a > 0.02) placed.push(box);

      item.alpha = a;
      el.style.opacity = a.toFixed(3);
      el.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) translate(-6px, -50%)`;
      el.style.display = a < 0.02 ? 'none' : 'flex';
    }
  }
}

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
