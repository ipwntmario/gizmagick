// Strict local preflight before invoking a codec decoder. This intentionally
// supports one complete, unmultiplexed mono/stereo Vorbis or Opus stream.
export const AUDIO_PROBE_LIMITS = Object.freeze({ bytes: 16777216, seconds: 1800,
  timeoutMs: 30000, trackTimeoutMs: 120000, packetBytes: 262144, pages: 65536, channels: 2, sampleRate: 96000 });
export class AudioProbeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const rejectAudio = (code, message) => { throw new AudioProbeError(code, message); };
const text = bytes => new TextDecoder().decode(bytes);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  return crc;
});
export function oggPageCRC(page) {
  let crc = 0;
  for (let index = 0; index < page.length; index++) {
    const byte = index >= 22 && index < 26 ? 0 : page[index];
    crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 255]) >>> 0;
  }
  return crc;
}

export function inspectOgg(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > AUDIO_PROBE_LIMITS.bytes) rejectAudio('audio-size', 'Audio must be nonempty and at most 16 MiB.');
  let offset = 0, serial, pages = 0, packetBytes = 0, packetParts = [], packets = 0;
  let pending = false, ended = false, granule = 0n;
  const headers = [];
  while (offset < bytes.length) {
    if (ended) rejectAudio('ogg-stream', 'Trailing data, chained streams, and multiplexed audio are not supported.');
    if (bytes.length - offset < 27) rejectAudio('ogg-truncated', 'Incomplete Ogg page header.');
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
    const flags = bytes[offset + 5], segments = bytes[offset + 26];
    if (text(bytes.subarray(offset, offset + 4)) !== 'OggS' || bytes[offset + 4] !== 0 || (flags & ~7)) rejectAudio('ogg-header', 'Invalid Ogg page header.');
    if (view.getUint32(18, true) !== pages || pages >= AUDIO_PROBE_LIMITS.pages) rejectAudio('ogg-sequence', 'Ogg pages must be consecutive, starting at zero.');
    if (!pages) {
      serial = view.getUint32(14, true);
      if (!(flags & 2) || (flags & 1)) rejectAudio('ogg-header', 'Audio must start at the beginning of a logical stream.');
    } else if ((flags & 2) || view.getUint32(14, true) !== serial) rejectAudio('ogg-stream', 'Only one logical audio stream is supported.');
    if (Boolean(flags & 1) !== pending) rejectAudio('ogg-packet', 'Invalid packet continuation.');
    const body = offset + 27 + segments;
    if (body > bytes.length) rejectAudio('ogg-truncated', 'Incomplete Ogg lacing table.');
    const lacing = bytes.subarray(offset + 27, body);
    const end = body + lacing.reduce((sum, length) => sum + length, 0);
    if (end > bytes.length) rejectAudio('ogg-truncated', 'Incomplete Ogg page body.');
    if (oggPageCRC(bytes.subarray(offset, end)) !== view.getUint32(22, true)) rejectAudio('ogg-checksum', 'Ogg page checksum failed.');
    const position = view.getBigInt64(6, true);
    if (position < -1n || (position >= 0n && position < granule)) rejectAudio('ogg-granule', 'Invalid or decreasing Ogg sample position.');
    if (position >= 0n) granule = position;
    let cursor = body;
    for (const size of lacing) {
      packetBytes += size;
      if (packetBytes > AUDIO_PROBE_LIMITS.packetBytes) rejectAudio('ogg-packet-limit', 'An Ogg packet exceeds 256 KiB.');
      if (packets < 3) packetParts.push(bytes.subarray(cursor, cursor + size));
      cursor += size;
      pending = size === 255;
      if (!pending) {
        if (packets < 3) {
          const packet = new Uint8Array(packetBytes);
          let start = 0;
          for (const part of packetParts) { packet.set(part, start); start += part.length; }
          headers.push(packet);
        }
        packets++; packetBytes = 0; packetParts = [];
      }
    }
    if (!pages && (packets !== 1 || pending || position !== 0n)) rejectAudio('ogg-header', 'The first page must contain only a complete identification packet at position zero.');
    ended = Boolean(flags & 4);
    if (ended && (pending || position <= 0n)) rejectAudio('ogg-end', 'The end page must complete its packets and declare positive audio length.');
    pages++; offset = end;
  }
  if (!ended || pending) rejectAudio('ogg-truncated', 'A complete Ogg end-of-stream page is required.');
  const first = headers[0], headerView = new DataView(first.buffer, first.byteOffset, first.length);
  let codec, channels, sampleRate, preSkip = 0, initialOverlapSamples = 0;
  if (text(first.subarray(0, 8)) === 'OpusHead') {
    codec = 'opus'; sampleRate = 48000; channels = first[9];
    if (first.length !== 19 || first[8] !== 1 || first[18] !== 0) rejectAudio('audio-codec', 'Only version-1 mono/stereo Opus mapping family zero is supported.');
    preSkip = headerView.getUint16(10, true);
    if (!headers[1] || text(headers[1].subarray(0, 8)) !== 'OpusTags' || packets < 3) rejectAudio('audio-codec', 'Missing Opus comment or audio packets.');
  } else if (first[0] === 1 && text(first.subarray(1, 7)) === 'vorbis') {
    codec = 'vorbis';
    if (first.length !== 30 || headerView.getUint32(7, true) !== 0 || first[29] !== 1) rejectAudio('audio-codec', 'Invalid Vorbis identification header.');
    channels = first[11]; sampleRate = headerView.getUint32(12, true);
    const small = first[28] & 15, large = first[28] >>> 4;
    if (small < 6 || large > 13 || small > large) rejectAudio('audio-codec', 'Invalid Vorbis block sizes.');
    initialOverlapSamples = (1 << small) / 2;
    if (packets < 4 || headers[1]?.[0] !== 3 || headers[2]?.[0] !== 5
        || headers.slice(1).some(header => text(header.subarray(1, 7)) !== 'vorbis')) rejectAudio('audio-codec', 'Missing Vorbis comment, setup, or audio packets.');
  } else rejectAudio('audio-codec', 'Only Ogg Vorbis and Ogg Opus are supported.');
  if (!Number.isInteger(channels) || channels < 1 || channels > AUDIO_PROBE_LIMITS.channels
      || sampleRate < 8000 || sampleRate > AUDIO_PROBE_LIMITS.sampleRate) rejectAudio('audio-format-limit', 'Audio must be mono/stereo with a sample rate of 8–96 kHz.');
  const sampleCount = granule - BigInt(preSkip);
  if (sampleCount <= 0n || sampleCount > BigInt(sampleRate * AUDIO_PROBE_LIMITS.seconds)) rejectAudio('audio-duration-limit', 'Audio must have a positive duration of at most 30 minutes.');
  return { codec, channels, sampleRate, sampleCount: Number(sampleCount), initialOverlapSamples, pages };
}
