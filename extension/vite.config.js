import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    target: 'chrome120',
    outDir: 'dist',
    emptyOutDir: true,
    minify: true,
    lib: {
      entry: resolve(__dirname, 'src/offscreen-browser.js'),
      name: 'YouTubeMusicNotesOffscreen',
      formats: ['iife'],
      fileName: () => 'offscreen.bundle.js'
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  }
});
