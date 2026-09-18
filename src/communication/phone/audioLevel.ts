/**
 * Decodes G.711 µ-law audio (the format Twilio Media Streams sends) and
 * reduces each chunk to a single 0..1 amplitude level, for driving a live
 * waveform visualization — not for playback or transcription, so a
 * simplified RMS-over-decoded-samples is enough; no need for a full audio
 * pipeline.
 */

// Standard ITU-T G.711 µ-law -> 16-bit linear PCM decode table (256 entries).
// This is the textbook algorithm (bias 0x84, exponent/mantissa decode),
// not something to hand-derive per call — computed once at module load.
const MULAW_DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const muLawByte = ~i & 0xff;
    const sign = muLawByte & 0x80;
    const exponent = (muLawByte >> 4) & 0x07;
    const mantissa = muLawByte & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

function decodeMuLaw(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    samples[i] = MULAW_DECODE_TABLE[bytes[i]!]!;
  }
  return samples;
}

/**
 * Computes a normalized (0..1) RMS amplitude for one base64-encoded µ-law
 * chunk, as sent in a Twilio Media Streams "media" event's `media.payload`.
 */
export function computeAudioLevel(base64Payload: string): number {
  const bytes = Buffer.from(base64Payload, "base64");
  if (bytes.length === 0) return 0;

  const samples = decodeMuLaw(bytes);
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples.length);

  // 16-bit PCM max magnitude is 32768; µ-law's decoded dynamic range in
  // ordinary speech rarely approaches that, so normalize against a lower
  // practical ceiling to get a visually useful 0..1 range instead of
  // values that are always near 0.
  const PRACTICAL_CEILING = 8000;
  return Math.min(1, rms / PRACTICAL_CEILING);
}
