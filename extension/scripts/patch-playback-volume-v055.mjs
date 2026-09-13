import fs from 'node:fs';

function replaceIn(path, replacements) {
  let text = fs.readFileSync(path, 'utf8');
  for (const [from, to, label] of replacements) {
    if (!text.includes(from)) throw new Error(`${path}: missing ${label}`);
    text = text.replace(from, to);
  }
  fs.writeFileSync(path, text);
}

replaceIn('result.js', [
  [
    "  const peak = 0.018 + confidence * 0.026;",
    "  const peak = 0.032 + confidence * 0.045;",
    'detected guitar note gain',
  ],
  [
    "    const noisePeak = 0.006 + confidence * 0.009;",
    "    const noisePeak = 0.010 + confidence * 0.014;",
    'detected guitar pluck gain',
  ],
  [
    "  masterGain = audioContext.createGain();\n  masterGain.gain.setValueAtTime(result?.instrument === 'guitar' ? 0.92 : 0.82, audioContext.currentTime);\n  masterGain.connect(audioContext.destination);",
    "  masterGain = audioContext.createGain();\n  masterGain.gain.setValueAtTime(result?.instrument === 'guitar' ? 1.28 : 1.12, audioContext.currentTime);\n  const playbackCompressor = audioContext.createDynamicsCompressor();\n  playbackCompressor.threshold.setValueAtTime(-16, audioContext.currentTime);\n  playbackCompressor.knee.setValueAtTime(18, audioContext.currentTime);\n  playbackCompressor.ratio.setValueAtTime(4, audioContext.currentTime);\n  playbackCompressor.attack.setValueAtTime(0.003, audioContext.currentTime);\n  playbackCompressor.release.setValueAtTime(0.18, audioContext.currentTime);\n  masterGain.connect(playbackCompressor);\n  playbackCompressor.connect(audioContext.destination);",
    'detected playback compressor chain',
  ],
]);

replaceIn('clean-playback.js', [
  [
    "  compressor.threshold.setValueAtTime(-18, ctx.currentTime);",
    "  compressor.threshold.setValueAtTime(-20, ctx.currentTime);",
    'clean compressor threshold',
  ],
  [
    "  compressor.knee.setValueAtTime(18, ctx.currentTime);",
    "  compressor.knee.setValueAtTime(20, ctx.currentTime);",
    'clean compressor knee',
  ],
  [
    "  master.gain.setValueAtTime(mode === 'all' ? 0.52 : 0.88, ctx.currentTime);",
    "  master.gain.setValueAtTime(mode === 'all' ? 0.82 : 1.02, ctx.currentTime);",
    'clean master gain',
  ],
  [
    "      ? 0.09 + confidence * 0.07\n      : 0.17 + confidence * 0.11;",
    "      ? 0.14 + confidence * 0.10\n      : 0.22 + confidence * 0.14;",
    'clean note gain',
  ],
  [
    "    gain.gain.setValueAtTime(Math.max(mode === 'all' ? 0.026 : 0.07, peak * 0.76), when + Math.min(0.09, legatoDuration * 0.35));",
    "    gain.gain.setValueAtTime(Math.max(mode === 'all' ? 0.040 : 0.090, peak * 0.78), when + Math.min(0.09, legatoDuration * 0.35));",
    'clean sustain gain',
  ],
]);

for (const path of ['manifest.json', 'package.json']) {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  data.version = '0.5.5';
  if (path === 'manifest.json') {
    data.description = 'Capture the first 90 seconds of YouTube audio, run stable Guitar Ear Phase-2d plus adaptive tempo-aware stroke merging locally in Chrome, and provide louder compressor-protected A/B playback for evaluation.';
  }
  fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

console.log('PLAYBACK_VOLUME_V055_PATCH_OK detected=boosted clean=boosted lead=boosted');
