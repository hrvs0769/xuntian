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

// 低清层路径：/tex/xxx.webp → /tex/lo/xxx.webp
// 云层原本是 PNG，但低清层统一编码成 WebP（512 宽时带 alpha 的 WebP 更小）。
function loPath(url) {
  const p = url.split('?')[0];
  const i = p.lastIndexOf('/');
  const dir = p.slice(0, i + 1);
  const file = p.slice(i + 1).replace(/\.(png|jpe?g)$/i, '.webp');
  return dir + 'lo/' + file;
}

/**
 * 加载贴图。
 *
 * lo: true 时先取 /tex/lo/ 下的 512 宽版本，并把高清地址记在 texture.userData.hiUrl 上，
 * 之后由 upgradeRoot() 在后台换成高清。
 *
 * 为什么要分级：github.io 对国内单连接限速约 46KB/s，3.35MB 要 70 秒。
 * 但全景时所有行星都只有几个像素，512 宽绰绰有余——
 * 高清贴图只在"镜头真的推到某颗星球上"时才有意义。
 */
export function loadTex(url, { srgb = true, aniso = 8, lo = false } = {}) {
  progress.total++;
  const real = lo ? loPath(url) : url;
  return new Promise((done) => {
    loader.load(
      resolve(real),
      (tex) => {
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.anisotropy = aniso;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        // 只有低清版本才需要记住高清地址
        if (lo) tex.userData.hiUrl = url;
        progress.loaded++;
        done(tex);
      },
      undefined,
      () => { progress.loaded++; done(null); }
    );
  });
}

/** 把材质里所有指向 oldTex 的贴图槽换成 newTex（含 uniforms） */
export function swapTex(mat, oldTex, newTex) {
  let hit = false;
  for (const k of Object.keys(mat)) {
    if (mat[k] === oldTex) { mat[k] = newTex; hit = true; }
  }
  if (mat.uniforms) {
    for (const k of Object.keys(mat.uniforms)) {
      if (mat.uniforms[k] && mat.uniforms[k].value === oldTex) {
        mat.uniforms[k].value = newTex;
        hit = true;
      }
    }
  }
  if (hit) mat.needsUpdate = true;
  return hit;
}

/**
 * 把一棵子树里的低清贴图逐个换成高清。
 *
 * 串行而不是并发：这些请求和用户接下来的操作抢同一条带宽，
 * 一次一个反而不会让"点开某颗行星"卡住。
 */
export async function upgradeRoot(root, { onStep } = {}) {
  // 先收集，边遍历边替换会打乱 traverse
  const jobs = [];
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const mat of mats) {
      if (mat.userData && mat.userData.upgraded) continue;
      const seen = new Set();
      const collect = (t) => {
        if (t && t.isTexture && t.userData && t.userData.hiUrl && !seen.has(t)) {
          seen.add(t);
          jobs.push({ mat, tex: t });
        }
      };
      for (const k of Object.keys(mat)) collect(mat[k]);
      if (mat.uniforms) for (const k of Object.keys(mat.uniforms)) collect(mat.uniforms[k].value);
    }
  });

  for (const { mat, tex } of jobs) {
    const hi = await loadTex(tex.userData.hiUrl, {
      srgb: tex.colorSpace === THREE.SRGBColorSpace,
      aniso: tex.anisotropy,
    });
    if (!hi) continue;
    swapTex(mat, tex, hi);
    tex.dispose();
    if (onStep) onStep();
  }

  // 法线贴图是从反照率实时算的，换了高清反照率之后要重算一遍
  const normals = [];
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const mat of mats) {
      if (mat.userData && mat.userData.normalSrc) normals.push(mat);
    }
  });
  for (const mat of normals) {
    const { width, strength } = mat.userData.normalSrc;
    // 用升级后的反照率重算（此时 uMap 已经是高清版本）
    const src = (mat.uniforms && mat.uniforms.uMap && mat.uniforms.uMap.value) || mat.map;
    if (!src || !src.image) continue;
    const n = await makeNormalMap(src, { width, strength });
    if (!n) continue;
    const old = mat.uniforms && mat.uniforms.uNormal ? mat.uniforms.uNormal.value : null;
    if (old) swapTex(mat, old, n);
    else swapTex(mat, mat.normalMap, n);
    if (old) old.dispose();
  }
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
export async function makeNormalMap(source, { width = 1024, strength = 2.2 } = {}) {
  // source 可以是 url、HTMLImageElement，或已经加载好的 THREE.Texture。
  // 传 texture 时会复用它的 image——否则同一张 moon_4k 会被下载两遍。
  const img = source && source.image ? source.image
    : (typeof source === 'string' ? await loadImage(source) : source);
  if (!img) return null;
  const w = width, h = Math.round(width / 2);

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const sctx = cv.getContext('2d', { willReadFrequently: true });
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
