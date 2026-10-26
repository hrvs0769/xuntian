import { defineConfig } from 'vite';

export default defineConfig({
  // 相对 base：dist 可以放在任意子路径下——
  // GitHub Pages 的 /<repo>/、对象存储的某个目录、或者直接双击 index.html 打开。
  // 贴图的运行时路径由 src/core/textures.js 里的 resolve() 负责拼这个前缀。
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    // 不内联任何资源：贴图都在 public/ 下，内联只会让首屏 JS 变大
    assetsInlineLimit: 0,
  },
  server: {
    port: 5199,
  },
});
