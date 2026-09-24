import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  // Test scripts set FOX_NO_HMR so edits elsewhere (e.g. ../spec.json) never reload a page mid-run.
  server: { fs: { allow: ['..'] }, hmr: process.env.FOX_NO_HMR ? false : undefined },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    // index.html: 3D + 2D (switch in the toolbar); live2d.html: the 2D puppet alone
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), live2d: resolve(__dirname, 'live2d.html') } },
  },
});
