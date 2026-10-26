// 贴图加载与派生：法线贴图（由反照率亮度做 Sobel）
import * as THREE from 'three';

const loader = new THREE.TextureLoader();
export const progress = { loaded: 0, total: 0 };

// 资源前缀。
// 贴图原来是写死的 '/tex/xxx.jpg'——绝对路径只在"站点部署在根目录"时成立。
// 部署到 GitHub Pages 的 /<repo>/ 下，或者放进任何子目录，全部 404。
// 这里统一拼 BASE_URL（vite.config.js 里 base: './' → './'），
// 于是同一份 dist 放在哪里都能跑。
const BASE = import.meta.env.BASE_URL || './';

function resolve(p) {
  if (!p) return p;
  if (/^(https?:)?\/\//.test(p) || p.startsWith('data:') || p.startsWith('blob:')) return p;
  const b = BASE.endsWith('/') ? BASE : BASE + '/';
  return b + p.replace(/^\//, '');
}

export function loadTex(url, { srgb = true, aniso = 8 } = {}) {
  progress.total++;
  return new Promise((done) => {
    loader.load(
      resolve(url),
      (tex) => {
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.anisotropy = aniso;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        progress.loaded++;
        done(tex);
      },
      undefined,
      () => { progress.loaded++; done(null); }
    );
  });
}

function loadImage(url) {
  return new Promise((done) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = resolve(url);
  });
}

/** 由反照率亮度生成法线贴图（岩质天体的浮雕感） */
export async function makeNormalMap(url, { width = 1024, strength = 2.2 } = {}) {
  const img = await loadImage(url);
  if (!img) return null;
  const w = width, h = Math.round(width / 2);

  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0, w, h);
  const sd = sctx.getImageData(0, 0, w, h).data;

  // 亮度 → 高度
  const height = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    height[i] = (sd[i * 4] * 0.299 + sd[i * 4 + 1] * 0.587 + sd[i * 4 + 2] * 0.114) / 255;
  }
  // 轻度模糊，避免噪点被当成地形
  const blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = (x + dx + w) % w;
          s += height[yy * w + xx]; n++;
        }
      }
      blur[y * w + x] = s / n;
    }
  }

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const oimg = octx.createImageData(w, h);
  const od = oimg.data;
  const at = (x, y) => blur[Math.min(h - 1, Math.max(0, y)) * w + ((x + w) % w)];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = at(x - 1, y), r = at(x + 1, y);
      const u = at(x, y - 1), d2 = at(x, y + 1);
      let nx = (l - r) * strength * 8;
      let ny = (u - d2) * strength * 8;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      const o = (y * w + x) * 4;
      od[o] = (nx / len * 0.5 + 0.5) * 255;
      od[o + 1] = (ny / len * 0.5 + 0.5) * 255;
      od[o + 2] = (nz / len * 0.5 + 0.5) * 255;
      od[o + 3] = 255;
    }
  }
  octx.putImageData(oimg, 0, 0);

  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  return tex;
}
