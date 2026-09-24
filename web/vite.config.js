import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Test scripts set FOX_NO_HMR so edits elsewhere (e.g. ../spec.json) never reload a page mid-run.
  server: { fs: { allow: ['..'] }, hmr: process.env.FOX_NO_HMR ? false : undefined },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
