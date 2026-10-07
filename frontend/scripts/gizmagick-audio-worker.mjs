import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { AUDIO_PROBE_LIMITS, inspectOgg, rejectAudio } from './lib/ogg-validation.mjs';

// Runs only in a local Node worker thread, never inside the Cloudflare Worker.
async function decode(bytes) {
  const info = inspectOgg(bytes);
  const Decoder = info.codec === 'vorbis'
    ? (await import('@wasm-audio-decoders/ogg-vorbis')).OggVorbisDecoder
    : (await import('ogg-opus-decoder')).OggOpusDecoder;
  const decoder = new Decoder();
  let samples = 0;
  const consume = result => {
    if (result.errors?.length) rejectAudio('audio-decode', 'The codec reported an error while decoding audio.');
    if (!Number.isSafeInteger(result.samplesDecoded) || result.samplesDecoded < 0) rejectAudio('audio-decode', 'Invalid decoded sample count.');
    if (!result.samplesDecoded) return;
    if (result.sampleRate !== info.sampleRate || result.channelData.length !== info.channels) rejectAudio('audio-decode', 'Decoded format differs from the stream header.');
    for (const channel of result.channelData) {
      if (channel.length !== result.samplesDecoded) rejectAudio('audio-decode', 'Decoded channels have inconsistent lengths.');
      for (const value of channel) if (!Number.isFinite(value)) rejectAudio('audio-decode', 'The decoder produced non-finite samples.');
    }
    samples += result.samplesDecoded;
    if (samples / info.sampleRate > AUDIO_PROBE_LIMITS.seconds) rejectAudio('audio-duration-limit', 'Decoded audio exceeds 30 minutes.');
  };
  try {
    await decoder.ready;
    // Discard PCM after each bounded input chunk instead of retaining a full
    // decoded track. The decoder may buffer an Ogg page until it is complete.
    for (let start = 0; start < bytes.length; start += 8192) consume(await decoder.decode(bytes.subarray(start, start + 8192)));
    consume(await decoder.flush());
    // The pinned Vorbis decoder omits the initial half-short-block overlap in
    // some streams. Accept only that exact bounded difference (or zero), and
    // measure returned PCM rather than inventing/padding samples from metadata.
    const difference = info.sampleCount - samples;
    if (!samples || (difference !== 0 && !(info.codec === 'vorbis' && difference === info.initialOverlapSamples))) rejectAudio('audio-duration-mismatch', 'Decoded sample count does not match the complete Ogg stream.');
    return { codec: info.codec, channels: info.channels, sampleRate: info.sampleRate,
      sampleCount: samples, containerSampleCount: info.sampleCount, initialOverlapSamples: difference,
      durationSeconds: samples / info.sampleRate, byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { decoder.free(); }
}

try { parentPort.postMessage({ result: await decode(workerData.bytes) }); }
catch (error) { parentPort.postMessage({ error: { code: error.code || 'audio-decode', message: error.code ? error.message : 'Audio decoding failed.' } }); }
