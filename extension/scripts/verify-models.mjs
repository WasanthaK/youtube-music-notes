import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Run from extension/. Verifies shipped model files against public/models/manifest.json.
const SRC_DIR = path.join('public', 'models');
const DIST_DIR = path.join('dist', 'models');
const MANIFEST_NAME = 'manifest.json';

const problems = [];

function fail(message) {
  problems.push(message);
  console.log(`FAIL ${message}`);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, MANIFEST_NAME), 'utf8'));
} catch (err) {
  console.error(`verify-models: cannot read ${path.join(SRC_DIR, MANIFEST_NAME)}: ${err.message}`);
  process.exit(1);
}
if (manifest.schema !== 'youtube-music-notes.model-manifest' || !Array.isArray(manifest.models)) {
  console.error('verify-models: manifest.json has an unexpected schema or no "models" array');
  process.exit(1);
}

const files = [];
for (const model of manifest.models) {
  for (const f of model.files || []) files.push({ model: model.id, ...f });
}
const listed = new Set(files.map((f) => f.path));

function checkFile(dir, entry) {
  const full = path.join(dir, entry.path);
  if (!fs.existsSync(full)) {
    fail(`${full}: missing`);
    return;
  }
  const data = fs.readFileSync(full);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const errors = [];
  if (data.length !== entry.bytes) errors.push(`size ${data.length} != expected ${entry.bytes}`);
  if (sha256 !== entry.sha256) errors.push(`sha256 ${sha256} != expected ${entry.sha256}`);
  if (errors.length) {
    fail(`${full}: ${errors.join('; ')}`);
  } else {
    console.log(`OK   ${full} (${data.length} bytes, sha256 ${sha256})`);
  }
}

const dirs = [SRC_DIR];
if (fs.existsSync(DIST_DIR)) dirs.push(DIST_DIR);
else console.log(`SKIP ${DIST_DIR} (not present)`);

for (const dir of dirs) {
  for (const entry of files) checkFile(dir, entry);
}

for (const name of fs.readdirSync(SRC_DIR)) {
  if (name === MANIFEST_NAME || listed.has(name)) continue;
  fail(`${path.join(SRC_DIR, name)}: not listed in ${MANIFEST_NAME}`);
}

if (problems.length) {
  console.error(`\nverify-models: ${problems.length} problem(s) found:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`verify-models: ${files.length} file(s) verified in ${dirs.length} location(s)`);
