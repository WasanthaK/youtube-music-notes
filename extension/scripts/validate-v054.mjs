import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = path => fs.readFileSync(path, 'utf8');
const manifest = JSON.parse(read('manifest.json'));
if (manifest.version !== '0.5.7') throw new Error(`expected v0.5.7, got ${manifest.version}`);

const popup = read('popup.js');
if (!popup.includes('const BENCHMARK_START_SECONDS = 0;')) throw new Error('capture must start at 0s');
if (!popup.includes('const BENCHMARK_END_SECONDS = 90;')) throw new Error('capture must end at 90s');
if (!popup.includes("benchmarkMode: 'fixed-90s-v1'")) throw new Error('missing fixed-90s-v1 benchmark mode');

const worker = read('service_worker.js');
for (const marker of [
  'runtime-refresh-v057', 'resetOffscreenForCapture',
  'waitForYouTubeMediaTime(tab.id, endSeconds, segmentSeconds)',
  'Math.ceil((segmentDuration + 15) * 1000)'
]) {
  if (!worker.includes(marker)) throw new Error(`missing runtime reliability marker: ${marker}`);
}
if (worker.includes('}, 60000);')) throw new Error('fixed 60-second media watcher timeout must be removed');

const clean = read('clean-playback.js');
for (const marker of [
  "playClean('all', 90)", "playClean('lead', 90)", "playClean('bridged', 90)", 'showLocalGapSummary(90)',
  "mode === 'all' ? 0.82 : 1.02", '? 0.14 + confidence * 0.10', ': 0.22 + confidence * 0.14',
  "compressor.threshold.setValueAtTime(-20, ctx.currentTime)",
  'rhythm-guitar-render-v1', 'violin-legato-render-v1',
  'playRhythmGuitar(90)', 'playViolinLegato(90)',
  "const roleMax = musicalRole === 'lead' ? 0.58 : musicalRole === 'double-stop' ? 0.44 : 0.34",
  "const maxDryDuration = musicalRole === 'lead' ? 0.72 : musicalRole === 'double-stop' ? 0.46 : 0.34"
]) {
  if (!clean.includes(marker)) throw new Error(`missing musical playback marker: ${marker}`);
}

const original = read('original-audio.js');
if (!original.includes('playOriginalAudio(1, 90)')) throw new Error('original playback must be 90s');
if (!original.includes('playOriginalAudio(0.75, 90)')) throw new Error('slow original playback must be 90s');

const result = read('result.js');
for (const marker of [
  'startPlayback(90, 1)', 'startPlayback(90, 0.75)',
  'const peak = 0.032 + confidence * 0.045;',
  "result?.instrument === 'guitar' ? 1.28 : 1.12",
  "const musicalRole = note.musicalRole || 'unknown';",
  "const maxSourceDuration = musicalRole === 'lead' ? 1.10 : musicalRole === 'double-stop' ? 0.52 : 0.38"
]) {
  if (!result.includes(marker)) throw new Error(`missing detected playback marker: ${marker}`);
}

execFileSync(process.execPath, ['--check', 'clean-playback.js'], { stdio: 'inherit' });
execFileSync(process.execPath, ['--check', 'result.js'], { stdio: 'inherit' });
execFileSync(process.execPath, ['--check', 'service_worker.js'], { stdio: 'inherit' });

const bundle = read('dist/offscreen.bundle.js');
for (const marker of [
  'tempo-adaptive-stroke-v3', 'adaptiveSecondaryStroke', 'secondaryStrokeCount',
  'presence-soft-fallback-v1', 'browser-tempo-v1', 'phase2d-stable',
  'guitar-ear-v0.2d-hardneg.best.pt', 'chrome-extension-browser',
  'guitar-performance-decoder-v1', 'musical_decoder', 'musical_role',
  'sameNoteRetriggersMerged', 'octaveSwitchesSuppressed', 'duplicatePitchClassRemoved'
]) {
  if (!bundle.includes(marker)) throw new Error(`missing bundle marker: ${marker}`);
}
if (bundle.includes('127.0.0.1:8765/transcribe')) throw new Error('localhost transcription dependency must not be packaged');

console.log('V057_VALIDATION_OK', {
  version: manifest.version,
  capture: '00:00-01:30',
  playbackSeconds: 90,
  runtime: 'fresh-offscreen + scalable media-time timeout',
  rhythm: 'tempo-adaptive-stroke-v3',
  model: 'phase2d-stable',
  musicalDecoder: 'guitar-performance-decoder-v1',
  articulation: 'dry-rhythm + sustained-lead',
});
