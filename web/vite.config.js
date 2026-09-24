import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { fs: { allow: ['..'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
