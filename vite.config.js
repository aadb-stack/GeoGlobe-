import { defineConfig } from 'vite';

// Relative base so the built site works whether it's served from a domain
// root or a sub-path (e.g. GitHub Pages project sites).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
