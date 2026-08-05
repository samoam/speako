/**
 * Downsamples a raw interleaved PCM16 audio chunk into a compact min/max
 * "envelope" for oscilloscope-style rendering in the browser. Streaming full
 * 16kHz sample resolution over the WebSocket would be wasteful — a canvas
 * only has so many pixel columns to draw into, so each broadcast point
 * summarizes a small window of samples as its [min, max] range (the
 * standard audio-editor waveform technique), which also looks better than a
 * single averaged/peak value since it preserves the visual "busyness" of
 * the signal.
 *
 * Only the first channel (mic) is visualized when channelCount is 2
 * (mic+system interleaved, see soxCapture.ts) — a single waveform is enough
 * to confirm capture is active, which is the actual goal (a trust/debugging
 * signal), not a full multi-track view.
 */
export function computeWaveformEnvelope(chunk: Buffer, channelCount: number, targetPoints = 40): number[] {
  const bytesPerSample = 2;
  const frameSize = bytesPerSample * channelCount;
  const frameCount = Math.floor(chunk.length / frameSize);
  if (frameCount === 0) return [];

  const bucketSize = Math.max(1, Math.floor(frameCount / targetPoints));
  const envelope: number[] = [];

  for (let start = 0; start < frameCount; start += bucketSize) {
    const end = Math.min(start + bucketSize, frameCount);
    let min = 32767;
    let max = -32768;
    for (let frame = start; frame < end; frame++) {
      const sample = chunk.readInt16LE(frame * frameSize); // channel 0 only
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    envelope.push(Number((min / 32768).toFixed(3)), Number((max / 32768).toFixed(3)));
  }

  return envelope;
}
