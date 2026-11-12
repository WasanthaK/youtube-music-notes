import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(root, 'node_modules', '@spotify', 'basic-pitch', 'model');
const targetDir = resolve(root, 'dist', 'models', 'basic-pitch');

if (!existsSync(sourceDir)) {
  throw new Error(`Missing Basic Pitch model directory: ${sourceDir}`);
}
if (!existsSync(resolve(sourceDir, 'model.json'))) {
  throw new Error(`Missing Basic Pitch model.json: ${resolve(sourceDir, 'model.json')}`);
}

mkdirSync(targetDir, { recursive: true });

for (const file of readdirSync(sourceDir)) {
  const source = resolve(sourceDir, file);
  if (!statSync(source).isFile()) continue;
  copyFileSync(source, resolve(targetDir, file));
  console.log(`Copied basic-pitch/${file}`);
}
