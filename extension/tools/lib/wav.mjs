// WAV (RIFF/WAVE) reading and writing with Node built-ins only.
//
// readWav() supports PCM integer 16, 24 and 32 bit, IEEE float 32 bit, any channel count,
// plain WAVE_FORMAT_PCM / WAVE_FORMAT_IEEE_FLOAT headers and WAVE_FORMAT_EXTENSIBLE with a
// PCM or IEEE float sub-format. Anything else is rejected with a clear error.
// Channels are averaged to mono. (Chrome's OfflineAudioContext down-mix differs for more
// than two channels; this tool always averages.)

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
// Bytes 2..15 of KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT; bytes 0..1 hold the format code.
const KSDATAFORMAT_GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

export class WavFormatError extends Error {}

function formatName(code) {
  if (code === WAVE_FORMAT_PCM) return 'PCM';
  if (code === WAVE_FORMAT_IEEE_FLOAT) return 'IEEE float';
  if (code === WAVE_FORMAT_EXTENSIBLE) return 'WAVE_FORMAT_EXTENSIBLE';
  return `format code 0x${code.toString(16).padStart(4, '0')}`;
}

/**
 * Parse a WAV file.
 * @param {Uint8Array} bytes  Whole file contents.
 * @returns {{ sampleRate: number, channels: number, frames: number, encoding: string,
 *   bitsPerSample: number, extensible: boolean, durationSeconds: number,
 *   channelData: Float32Array[], mono: Float32Array }}
 */
export function readWav(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = offset => String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);

  if (buf.byteLength < 12) throw new WavFormatError('not a WAV file: shorter than a RIFF header');
  const riff = tag(0);
  if (riff === 'RF64' || riff === 'RIFX') throw new WavFormatError(`unsupported container ${riff}; only little-endian RIFF WAVE is supported`);
  if (riff !== 'RIFF' || tag(8) !== 'WAVE') throw new WavFormatError('not a WAV file: missing RIFF/WAVE header');

  let fmt = null;
  let dataOffset = -1;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= buf.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.byteLength) throw new WavFormatError('fmt chunk is truncated');
      fmt = {
        formatCode: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
        extensible: false,
      };
      if (fmt.formatCode === WAVE_FORMAT_EXTENSIBLE) {
        if (size < 40 || body + 40 > buf.byteLength) throw new WavFormatError('WAVE_FORMAT_EXTENSIBLE fmt chunk is truncated');
        const subFormat = view.getUint16(body + 24, true);
        const tail = Array.from(buf.subarray(body + 26, body + 40));
        if (tail.some((value, i) => value !== KSDATAFORMAT_GUID_TAIL[i])) {
          throw new WavFormatError('WAVE_FORMAT_EXTENSIBLE with a non-standard sub-format GUID is not supported');
        }
        fmt.extensible = true;
        fmt.validBitsPerSample = view.getUint16(body + 18, true);
        fmt.formatCode = subFormat;
      }
    } else if (id === 'data') {
      dataOffset = body;
      // Streamed writers may leave 0 or 0xFFFFFFFF here: use what the file actually holds.
      dataBytes = Math.min(size, buf.byteLength - body);
      if (fmt) break;
    }
    offset = body + size + (size % 2);
  }

  if (!fmt) throw new WavFormatError('no fmt chunk found');
  if (dataOffset < 0) throw new WavFormatError('no data chunk found');

  const { formatCode, channels, sampleRate, bitsPerSample, extensible } = fmt;
  if (!channels) throw new WavFormatError('fmt chunk declares 0 channels');
  if (!sampleRate) throw new WavFormatError('fmt chunk declares a 0 Hz sample rate');

  let encoding;
  if (formatCode === WAVE_FORMAT_PCM && [16, 24, 32].includes(bitsPerSample)) encoding = `pcm${bitsPerSample}`;
  else if (formatCode === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample === 32) encoding = 'float32';
  else {
    throw new WavFormatError(
      `unsupported WAV encoding: ${formatName(formatCode)}${extensible ? ' (extensible)' : ''}, ${bitsPerSample}-bit. ` +
      'Supported: PCM 16/24/32-bit integer and 32-bit IEEE float.'
    );
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  if (fmt.blockAlign && fmt.blockAlign !== frameBytes) {
    throw new WavFormatError(`fmt block align ${fmt.blockAlign} does not match ${channels} x ${bitsPerSample}-bit samples`);
  }
  const frames = Math.floor(dataBytes / frameBytes);

  const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    let pos = dataOffset + frame * frameBytes;
    for (let ch = 0; ch < channels; ch += 1) {
      let value;
      if (encoding === 'pcm16') value = view.getInt16(pos, true) / 32768;
      else if (encoding === 'pcm24') {
        let int = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
        if (int & 0x800000) int -= 0x1000000;
        value = int / 8388608;
      } else if (encoding === 'pcm32') value = view.getInt32(pos, true) / 2147483648;
      else value = view.getFloat32(pos, true);
      channelData[ch][frame] = value;
      pos += bytesPerSample;
    }
  }

  let mono;
  if (channels === 1) mono = channelData[0];
  else {
    mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch += 1) sum += channelData[ch][frame];
      mono[frame] = sum / channels;
    }
  }

  return {
    sampleRate,
    channels,
    frames,
    encoding,
    bitsPerSample,
    extensible,
    durationSeconds: frames / sampleRate,
    channelData,
    mono,
  };
}

const clamp1 = value => Math.max(-1, Math.min(1, value));

/**
 * Encode samples as a WAV file (used by the tests; also handy for debugging).
 * @param {Float32Array[]} channelData  One array per channel, equal lengths, values in [-1, 1].
 * @param {number} sampleRate
 * @param {{ encoding?: 'pcm16'|'pcm24'|'pcm32'|'float32', extensible?: boolean }} [options]
 * @returns {Uint8Array}
 */
export function encodeWav(channelData, sampleRate, { encoding = 'pcm16', extensible = false } = {}) {
  const channels = channelData.length;
  const frames = channels ? channelData[0].length : 0;
  const bitsPerSample = { pcm16: 16, pcm24: 24, pcm32: 32, float32: 32 }[encoding];
  if (!bitsPerSample) throw new Error(`encodeWav: unknown encoding ${encoding}`);
  const formatCode = encoding === 'float32' ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = bytesPerSample * channels;
  const dataBytes = frames * blockAlign;
  const fmtBytes = extensible ? 40 : 16;
  const total = 12 + 8 + fmtBytes + 8 + dataBytes + (dataBytes % 2);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  const writeTag = (offset, text) => { for (let i = 0; i < 4; i += 1) buf[offset + i] = text.charCodeAt(i); };

  writeTag(0, 'RIFF');
  view.setUint32(4, total - 8, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, fmtBytes, true);
  view.setUint16(20, extensible ? WAVE_FORMAT_EXTENSIBLE : formatCode, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  let offset = 36;
  if (extensible) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, bitsPerSample, true); // wValidBitsPerSample
    view.setUint32(40, 0, true); // dwChannelMask: unspecified
    view.setUint16(44, formatCode, true);
    buf.set(KSDATAFORMAT_GUID_TAIL, 46);
    offset = 60;
  }
  writeTag(offset, 'data');
  view.setUint32(offset + 4, dataBytes, true);
  let pos = offset + 8;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let ch = 0; ch < channels; ch += 1) {
      const value = clamp1(channelData[ch][frame]);
      if (encoding === 'pcm16') view.setInt16(pos, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true);
      else if (encoding === 'pcm24') {
        let int = Math.max(-8388608, Math.min(8388607, Math.round(value * 8388608)));
        if (int < 0) int += 0x1000000;
        buf[pos] = int & 0xff;
        buf[pos + 1] = (int >> 8) & 0xff;
        buf[pos + 2] = (int >> 16) & 0xff;
      } else if (encoding === 'pcm32') view.setInt32(pos, Math.max(-2147483648, Math.min(2147483647, Math.round(value * 2147483648))), true);
      else view.setFloat32(pos, value, true);
      pos += bytesPerSample;
    }
  }
  return buf;
}
