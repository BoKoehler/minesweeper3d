import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the same build works on GitHub Pages project sites,
  // user sites, and local `vite preview` without reconfiguration.
  base: './',
  build: { target: 'es2022', outDir: 'dist', sourcemap: false },
});
