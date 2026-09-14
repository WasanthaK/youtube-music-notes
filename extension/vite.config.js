import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    target: 'chrome120',
    outDir: 'dist',
    emptyOutDir: true,
    minify: true,
    lib: {
      entry: resolve(__dirname, 'src/offscreen-phase2d.js'),
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
