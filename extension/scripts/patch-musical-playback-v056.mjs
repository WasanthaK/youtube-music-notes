import fs from 'node:fs';

const path = 'clean-playback.js';
let text = fs.readFileSync(path, 'utf8');
if (text.includes('rhythm-guitar-render-v1')) throw new Error('musical playback patch already applied');

text += String.raw`

// v0.5.6 musical renderers. These do not alter transcription; they only render
// the same saved notes in a more musical way for listening and evaluation.
const MUSICAL_PLAYBACK_SECONDS = 90;
const MUSICAL_RENDERER_VERSION = 'rhythm-guitar-render-v1';
const VIOLIN_RENDERER_VERSION = 'violin-legato-render-v1';

function musicalOutputChain(ctx, gainValue = 1.0) {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-20, ctx.currentTime);
  compressor.knee.setValueAtTime(22, ctx.currentTime);
  compressor.ratio.setValueAtTime(4.5, ctx.currentTime);
  compressor.attack.setValueAtTime(0.004, ctx.currentTime);
  compressor.release.setValueAtTime(0.20, ctx.currentTime);

  const master = ctx.createGain();
  master.gain.setValueAtTime(gainValue, ctx.currentTime);
  master.connect(compressor);
  compressor.connect(ctx.destination);
  return master;
}

function rhythmStrokeClusters(notes) {
  const clusters = clusterNotes(notes, 0.04);
  return clusters.map(cluster => ({
    anchor: cluster.anchor,
    notes: [...cluster.notes]
      .sort((a, b) => Number(a.guitar?.string || 9) - Number(b.guitar?.string || 9) || Number(a.midi) - Number(b.midi))
      .slice(0, 6),
  }));
}

async function playRhythmGuitar(seconds = MUSICAL_PLAYBACK_SECONDS) {
  stopCleanPlayback();
  cleanAudioContext = new AudioContext();
  const ctx = cleanAudioContext;
  await ctx.resume();

  const result = await cleanLoadResult();
  if (!result?.notes?.length) {
    setCleanStatus('No saved notes found for rhythm-guitar playback.');
    stopCleanPlayback();
    return;
  }

  const valid = result.notes.filter(note =>
    Number.isFinite(Number(note.start)) && Number.isFinite(Number(note.midi)) && Number(note.start) < seconds
  );
  const strokes = rhythmStrokeClusters(valid);
  if (!strokes.length) {
    setCleanStatus('No tempo-aligned strokes found.');
    stopCleanPlayback();
    return;
  }

  const master = musicalOutputChain(ctx, 1.08);
  const startAt = ctx.currentTime + 0.08;
  let direction = 1;

  for (let s = 0; s < strokes.length; s += 1) {
    const stroke = strokes[s];
    const nextStroke = strokes[s + 1];
    const strokeWindow = Math.max(0.16, Math.min(0.72, (nextStroke?.anchor ?? seconds) - stroke.anchor));
    const notes = direction > 0 ? stroke.notes : [...stroke.notes].reverse();
    direction *= -1;

    for (let i = 0; i < notes.length; i += 1) {
      const note = notes[i];
      const when = startAt + stroke.anchor + i * 0.011;
      const confidence = Math.max(0, Math.min(1, Number(note.confidence || 0.5)));
      const frequency = cleanMidiToFrequency(note.midi);
      const duration = Math.max(0.20, Math.min(0.68, strokeWindow * 0.92));

      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(frequency, when);

      const body = ctx.createBiquadFilter();
      body.type = 'lowpass';
      body.frequency.setValueAtTime(Math.max(1400, Math.min(3900, frequency * 7.5)), when);
      body.Q.setValueAtTime(0.7, when);

      const gain = ctx.createGain();
      const peak = 0.085 + confidence * 0.075;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(peak, when + 0.006);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.018, peak * 0.38), when + Math.min(0.12, duration * 0.40));
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);

      osc.connect(body);
      body.connect(gain);
      gain.connect(master);
      osc.start(when);
      osc.stop(when + duration + 0.02);
      cleanSources.push(osc);
    }
  }

  setCleanStatus(
    'Playing rhythm guitar: ' + strokes.length + ' tempo-aligned strokes · alternating strum · 00:00–01:30.'
  );
  window.setTimeout(() => {
    if (cleanAudioContext === ctx) stopCleanPlayback();
  }, (seconds + 2.5) * 1000);
}

async function playViolinLegato(seconds = MUSICAL_PLAYBACK_SECONDS) {
  stopCleanPlayback();
  cleanAudioContext = new AudioContext();
  const ctx = cleanAudioContext;
  await ctx.resume();

  const result = await cleanLoadResult();
  if (!result?.notes?.length) {
    setCleanStatus('No saved notes found for violin playback.');
    stopCleanPlayback();
    return;
  }

  const lead = extractLeadLine(result.notes)
    .filter(note => Number.isFinite(Number(note.start)) && Number.isFinite(Number(note.midi)) && Number(note.start) < seconds);
  if (!lead.length) {
    setCleanStatus('No lead line found for violin playback.');
    stopCleanPlayback();
    return;
  }

  const master = musicalOutputChain(ctx, 1.04);
  const startAt = ctx.currentTime + 0.08;

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2300, startAt);
  filter.Q.setValueAtTime(1.05, startAt);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, startAt);

  const vibrato = ctx.createOscillator();
  vibrato.frequency.setValueAtTime(5.2, startAt);
  const vibratoDepth = ctx.createGain();
  vibratoDepth.gain.setValueAtTime(13, startAt); // cents
  vibrato.connect(vibratoDepth);
  vibratoDepth.connect(osc.detune);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(master);

  let previousFrequency = cleanMidiToFrequency(lead[0].midi);
  osc.frequency.setValueAtTime(previousFrequency, startAt);

  for (let i = 0; i < lead.length; i += 1) {
    const note = lead[i];
    const noteStart = startAt + Number(note.start);
    const nextStartSeconds = i + 1 < lead.length ? Number(lead[i + 1].start) : seconds;
    const gapToNext = Math.max(0, nextStartSeconds - Number(note.start));
    const frequency = cleanMidiToFrequency(note.midi);
    const confidence = Math.max(0, Math.min(1, Number(note.confidence || 0.5)));
    const level = 0.11 + confidence * 0.075;

    if (i === 0 || gapToNext > 1.1) {
      osc.frequency.setValueAtTime(frequency, noteStart);
    } else {
      osc.frequency.setValueAtTime(previousFrequency, Math.max(startAt, noteStart - 0.035));
      osc.frequency.exponentialRampToValueAtTime(frequency, noteStart + 0.035);
    }
    previousFrequency = frequency;

    gain.gain.cancelScheduledValues(noteStart);
    const current = Math.max(0.0001, gain.gain.value || 0.0001);
    gain.gain.setValueAtTime(current, noteStart);
    gain.gain.linearRampToValueAtTime(level, noteStart + 0.045);

    const sustainUntil = Math.max(
      noteStart + 0.18,
      startAt + Math.min(nextStartSeconds - 0.025, Number(note.start) + 1.6),
    );
    gain.gain.setValueAtTime(Math.max(0.045, level * 0.82), sustainUntil);

    if (gapToNext > 0.85 || i === lead.length - 1) {
      const fadeEnd = Math.min(startAt + seconds, sustainUntil + 0.20);
      gain.gain.exponentialRampToValueAtTime(0.0001, fadeEnd);
    }
  }

  osc.start(startAt);
  vibrato.start(startAt);
  const stopAt = startAt + seconds + 0.25;
  osc.stop(stopAt);
  vibrato.stop(stopAt);
  cleanSources.push(osc, vibrato);

  setCleanStatus(
    'Playing violin-style legato: ' + lead.length + ' lead notes · sustained phrasing + vibrato · 00:00–01:30.'
  );
  window.setTimeout(() => {
    if (cleanAudioContext === ctx) stopCleanPlayback();
  }, (seconds + 2.5) * 1000);
}

window.addEventListener('DOMContentLoaded', () => {
  const actions = document.querySelector('.playbackCard .playbackActions');
  if (!actions) return;

  const rhythmButton = document.createElement('button');
  rhythmButton.id = 'playRhythmGuitar';
  rhythmButton.textContent = '▶ Rhythm guitar · 00:00–01:30';
  rhythmButton.title = 'Same transcription rendered as tempo-aligned alternating guitar strums.';
  rhythmButton.addEventListener('click', () => void playRhythmGuitar(90));

  const violinButton = document.createElement('button');
  violinButton.id = 'playViolinLegato';
  violinButton.textContent = '▶ Violin legato · 00:00–01:30';
  violinButton.title = 'Same transcription lead line rendered with sustained notes, portamento and vibrato.';
  violinButton.addEventListener('click', () => void playViolinLegato(90));

  actions.append(rhythmButton, violinButton);
});
`;

fs.writeFileSync(path, text);

for (const file of ['manifest.json', 'package.json']) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = '0.5.6';
  if (file === 'manifest.json') {
    data.description = 'Capture the first 90 seconds of YouTube audio, transcribe with stable Phase-2d plus adaptive tempo-aware stroke merging, and audition the result as detected guitar, clean notes, rhythm guitar, or violin-style legato.';
  }
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

console.log('MUSICAL_PLAYBACK_V056_PATCH_OK rhythm-guitar-render-v1 violin-legato-render-v1');
