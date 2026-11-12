// Checks that src/pipeline.js and everything it imports can run outside a browser.
//
// (i)  Statically resolves the relative import graph of src/pipeline.js and fails if any
//      file in it references a browser global or a Node-only module, or imports a bare
//      package that is not on the allow-list below.
// (ii) Dynamically imports src/pipeline.js in plain Node and checks that transcribeAudio
//      is an exported function.
//
// Run from extension/: node scripts/test-pipeline-purity.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ENTRY = path.resolve('src/pipeline.js');

const FORBIDDEN = [
  'chrome', 'indexedDB', 'document', 'window', 'navigator', 'AudioContext', 'OfflineAudioContext',
  'MediaRecorder', 'fetch', 'localStorage', 'require', 'process', '__dirname', '__filename'
];

// Bare packages the pure pipeline may import, and why.
const ALLOWED_PACKAGES = {
  'fft.js': 'pure JavaScript FFT used by tempoAnalysis.js (already imported in Node by test-tempo-analysis.mjs)',
  '@spotify/basic-pitch': 'only the pure post-processing helpers outputToNotesPoly, addPitchBendsToNoteEvents and noteFramesToTime are used; the BasicPitch model class stays in offscreen-phase2d.js'
};

const failures = [];
const fail = message => { failures.push(message); console.log(`  FAIL ${message}`); };

// Replace comments with spaces, keep string literals. The files in the graph contain no
// regular-expression literals or nested template literals; if that changes, revisit this.
function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function importSpecifiers(code) {
  const specs = [];
  const staticRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(staticRe)) specs.push(match[1] || match[2]);
  return specs;
}

function checkIdentifiers(file, code) {
  const rel = path.relative(process.cwd(), file);
  for (const name of FORBIDDEN) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    const hits = [...code.matchAll(re)];
    if (!hits.length) continue;
    // A local variable that shadows a global (e.g. `const window = new Float64Array(...)`
    // for an FFT window) is not a reference to the global. Allow it only when the file
    // declares the binding and every other use is plain indexing (`name[...]`).
    const declared = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(code);
    const bad = hits.filter(hit => {
      const before = code.slice(Math.max(0, hit.index - 12), hit.index);
      const after = code.slice(hit.index + name.length, hit.index + name.length + 2);
      const isDeclaration = /\b(?:const|let|var)\s+$/.test(before);
      const isIndexing = /^\s*\[/.test(after);
      return !(declared && (isDeclaration || isIndexing));
    });
    if (bad.length) {
      const line = code.slice(0, bad[0].index).split('\n').length;
      fail(`${rel}:${line} references forbidden identifier "${name}"`);
    } else {
      console.log(`  note ${rel}: "${name}" appears only as a local variable (declaration + indexing), not the global`);
    }
  }
}

console.log('(i) static import graph of src/pipeline.js');
const visited = new Set();
const packages = new Map();
const queue = [ENTRY];
while (queue.length) {
  const file = queue.shift();
  if (visited.has(file)) continue;
  visited.add(file);
  const rel = path.relative(process.cwd(), file);
  if (!fs.existsSync(file)) { fail(`${rel} does not exist`); continue; }
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  console.log(`  file ${rel}`);
  if (/\bimport\s*\(/.test(code)) fail(`${rel} uses dynamic import(), which this check cannot follow`);
  checkIdentifiers(file, code);
  for (const spec of importSpecifiers(code)) {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      queue.push(path.resolve(path.dirname(file), spec));
    } else if (spec.startsWith('node:')) {
      fail(`${rel} imports Node-only module ${spec}`);
    } else if (Object.hasOwn(ALLOWED_PACKAGES, spec)) {
      if (!packages.has(spec)) packages.set(spec, new Set());
      packages.get(spec).add(rel);
    } else {
      fail(`${rel} imports bare package ${spec}, which is not on the allow-list`);
    }
  }
}
for (const [spec, importers] of packages) {
  console.log(`  package ${spec} (from ${[...importers].join(', ')}): allowed, ${ALLOWED_PACKAGES[spec]}`);
}
console.log(`  checked ${visited.size} files for: ${FORBIDDEN.join(', ')}`);

console.log('(ii) dynamic import of src/pipeline.js in plain Node');
try {
  const mod = await import(pathToFileURL(ENTRY).href);
  if (typeof mod.transcribeAudio !== 'function') fail('src/pipeline.js does not export a function named transcribeAudio');
  else console.log('  ok transcribeAudio is an exported function');
} catch (error) {
  const missing = error?.code === 'ERR_MODULE_NOT_FOUND'
    ? /Cannot find package '([^']+)'/.exec(error.message)?.[1]
    : null;
  if (missing && !fs.existsSync('node_modules')) {
    console.log(`  SKIPPED: npm package "${missing}" is not installed (no node_modules here; run npm install first).`);
    console.log('  The static check (i) still ran. CI installs dependencies, so (ii) runs there.');
  } else {
    fail(`importing src/pipeline.js failed: ${error?.message || error}`);
  }
}

if (failures.length) {
  console.log(`PIPELINE_PURITY_FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('PIPELINE_PURITY_OK');
