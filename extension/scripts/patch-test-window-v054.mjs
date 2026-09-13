import fs from 'node:fs';

function replaceIn(path, replacements) {
  let text = fs.readFileSync(path, 'utf8');
  for (const [from, to, label] of replacements) {
    if (!text.includes(from)) throw new Error(`${path}: missing ${label}`);
    text = text.replace(from, to);
  }
  fs.writeFileSync(path, text);
}

replaceIn('popup.js', [
  ['const BENCHMARK_START_SECONDS = 30;', 'const BENCHMARK_START_SECONDS = 0;', 'benchmark start'],
  ['const BENCHMARK_END_SECONDS = 60;', 'const BENCHMARK_END_SECONDS = 90;', 'benchmark end'],
  ["statusEl.textContent = 'Preparing automatic 0:30 → 1:00 benchmark…';", "statusEl.textContent = 'Preparing automatic 0:00 → 1:30 test capture…';", 'popup status'],
  ["benchmarkMode: 'fixed-30s-v1'", "benchmarkMode: 'fixed-90s-v1'", 'benchmark mode'],
]);

replaceIn('clean-playback.js', [
  ["async function playClean(mode = 'all', seconds = 10) {", "async function playClean(mode = 'all', seconds = 90) {", 'clean default duration'],
  ["async function showLocalGapSummary(seconds = 10) {", "async function showLocalGapSummary(seconds = 90) {", 'gap summary duration'],
  ["cleanButton.textContent = '▶ Clean notes · first 10 sec';", "cleanButton.textContent = '▶ Clean notes · 00:00–01:30';", 'clean label'],
  ["cleanButton.addEventListener('click', () => void playClean('all', 10));", "cleanButton.addEventListener('click', () => void playClean('all', 90));", 'clean playback duration'],
  ["leadButton.textContent = '▶ Lead line · first 10 sec';", "leadButton.textContent = '▶ Lead line · 00:00–01:30';", 'lead label'],
  ["leadButton.addEventListener('click', () => void playClean('lead', 10));", "leadButton.addEventListener('click', () => void playClean('lead', 90));", 'lead playback duration'],
  ["bridgedButton.textContent = '▶ Bridged lead · first 10 sec';", "bridgedButton.textContent = '▶ Bridged lead · 00:00–01:30';", 'bridged label'],
  ["bridgedButton.addEventListener('click', () => void playClean('bridged', 10));", "bridgedButton.addEventListener('click', () => void playClean('bridged', 90));", 'bridged playback duration'],
  ['void showLocalGapSummary(10);', 'void showLocalGapSummary(90);', 'gap summary invocation'],
]);

replaceIn('original-audio.js', [
  ["Run a new transcription to capture the original 30-second sample.", "Run a new transcription to capture the original 90-second sample.", 'old capture message'],
  ["document.querySelector('#playOriginalTen').addEventListener('click', () => playOriginalAudio(1, 10));", "document.querySelector('#playOriginalTen').addEventListener('click', () => playOriginalAudio(1, 90));", 'original playback duration'],
  ["document.querySelector('#playOriginalTenSlow').addEventListener('click', () => playOriginalAudio(0.75, 10));", "document.querySelector('#playOriginalTenSlow').addEventListener('click', () => playOriginalAudio(0.75, 90));", 'original slow duration'],
  ["status.textContent = 'Original 10-second comparison finished.';", "status.textContent = 'Original 90-second comparison finished.';", 'original completion status'],
]);

replaceIn('result.html', [
  ['▶ Original · first 10 sec', '▶ Original · 00:00–01:30', 'original button label'],
  ['▶ Original · first 10 sec · 0.75×', '▶ Original · 00:00–01:30 · 0.75×', 'original slow label'],
  ['▶ Guitar · first 10 sec', '▶ Guitar · 00:00–01:30', 'guitar button label'],
  ['▶ First 10 sec · 0.75×', '▶ 00:00–01:30 · 0.75×', 'guitar slow label'],
]);

replaceIn('result.js', [
  ["document.querySelector('#playTen').addEventListener('click', () => startPlayback(10, 1));", "document.querySelector('#playTen').addEventListener('click', () => startPlayback(90, 1));", 'guitar playback duration'],
  ["document.querySelector('#playTenSlow').addEventListener('click', () => startPlayback(10, 0.75));", "document.querySelector('#playTenSlow').addEventListener('click', () => startPlayback(90, 0.75));", 'guitar slow duration'],
]);

for (const path of ['manifest.json', 'package.json']) {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  data.version = '0.5.4';
  if (path === 'manifest.json') {
    data.description = 'Capture the first 90 seconds of YouTube audio, run stable Guitar Ear Phase-2d plus adaptive tempo-aware stroke merging locally in Chrome, retain the original audio for A/B comparison, and render playable TAB.';
  }
  fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

console.log('TEST_WINDOW_V054_PATCH_OK 00:00-01:30 playback=90s');
