const BYTES_PER_SAMPLE = 2; // LINEAR16

/**
 * Builds a 44-byte canonical WAV header for raw PCM16 data — shared by
 * WavRecorder (a live session's mic capture, streamed to disk then wrapped
 * once the total size is known) and generateAudioOverview.ts (a one-shot
 * TTS response, already fully in memory). Same math either way; pulled out
 * once so neither has to duplicate the WAV format details.
 */
export function buildWavHeader(dataBytes: number, sampleRate: number, channelCount: number): Buffer {
  const byteRate = sampleRate * channelCount * BYTES_PER_SAMPLE;
  const blockAlign = channelCount * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  return header;
}

/** Wraps a complete in-memory PCM16 buffer in a WAV header — for one-shot audio (e.g. a TTS response), unlike WavRecorder's streamed write()/finish(). */
export function pcmToWav(pcm: Buffer, sampleRate: number, channelCount: number): Buffer {
  return Buffer.concat([buildWavHeader(pcm.length, sampleRate, channelCount), pcm]);
}
