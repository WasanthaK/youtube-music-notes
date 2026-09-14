import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(root, 'node_modules', 'onnxruntime-web', 'dist');
const targetDir = resolve(root, 'dist', 'ort');

mkdirSync(targetDir, { recursive: true });

const files = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

for (const file of files) {
  const source = resolve(sourceDir, file);
  const target = resolve(targetDir, file);
  if (!existsSync(source)) {
    throw new Error(`Missing ONNX Runtime Web asset: ${source}`);
  }
  copyFileSync(source, target);
  console.log(`Copied ${file}`);
}
