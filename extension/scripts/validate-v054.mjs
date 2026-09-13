import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const manifest = JSON.parse(read('manifest.json'));
if (manifest.version !== '0.5.4') throw new Error(`expected v0.5.4, got ${manifest.version}`);

const popup = read('popup.js');
if (!popup.includes('const BENCHMARK_START_SECONDS = 0;')) throw new Error('capture must start at 0s');
if (!popup.includes('const BENCHMARK_END_SECONDS = 90;')) throw new Error('capture must end at 90s');
if (!popup.includes("benchmarkMode: 'fixed-90s-v1'")) throw new Error('missing fixed-90s-v1 benchmark mode');

const clean = read('clean-playback.js');
for (const marker of ["playClean('all', 90)", "playClean('lead', 90)", "playClean('bridged', 90)", 'showLocalGapSummary(90)']) {
  if (!clean.includes(marker)) throw new Error(`missing clean playback marker: ${marker}`);
}

const original = read('original-audio.js');
if (!original.includes('playOriginalAudio(1, 90)')) throw new Error('original playback must be 90s');
if (!original.includes('playOriginalAudio(0.75, 90)')) throw new Error('slow original playback must be 90s');

const result = read('result.js');
if (!result.includes('startPlayback(90, 1)')) throw new Error('guitar playback must be 90s');
if (!result.includes('startPlayback(90, 0.75)')) throw new Error('slow guitar playback must be 90s');

const bundle = read('dist/offscreen.bundle.js');
for (const marker of [
  'tempo-adaptive-stroke-v3', 'adaptiveSecondaryStroke', 'secondaryStrokeCount',
  'presence-soft-fallback-v1', 'browser-tempo-v1', 'phase2d-stable',
  'guitar-ear-v0.2d-hardneg.best.pt', 'chrome-extension-browser'
]) {
  if (!bundle.includes(marker)) throw new Error(`missing bundle marker: ${marker}`);
}
if (bundle.includes('127.0.0.1:8765/transcribe')) throw new Error('localhost transcription dependency must not be packaged');

console.log('V054_VALIDATION_OK', {
  version: manifest.version,
  capture: '00:00-01:30',
  playbackSeconds: 90,
  rhythm: 'tempo-adaptive-stroke-v3',
  model: 'phase2d-stable',
});
