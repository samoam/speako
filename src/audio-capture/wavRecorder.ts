import * as fs from 'fs';
import { config } from '../config';

const BYTES_PER_SAMPLE = 2; // LINEAR16

/**
 * Buffers raw PCM to disk during a session, then wraps it in a WAV header on
 * `finish()`. The header requires the total data length up front, which isn't
 * known until recording ends, so raw bytes are written to a temp file first
 * and the final .wav (header + data) is assembled only once the size is known.
 */
export class WavRecorder {
  private rawPath: string;
  private wavPath: string;
  private stream: fs.WriteStream;
  private bytesWritten = 0;

  constructor(sessionId: string, private channelCount: number) {
    fs.mkdirSync(config.audioDir, { recursive: true });
    this.rawPath = `${config.audioDir}/${sessionId}.raw`;
    this.wavPath = `${config.audioDir}/${sessionId}.wav`;
    this.stream = fs.createWriteStream(this.rawPath);
  }

  write(chunk: Buffer): void {
    this.bytesWritten += chunk.length;
    this.stream.write(chunk);
  }

  /** Closes the raw file, writes the final .wav, and returns its path. */
  async finish(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err: NodeJS.ErrnoException | null | undefined) => (err ? reject(err) : resolve()));
    });

    const header = this.buildWavHeader(this.bytesWritten);
    const raw = fs.readFileSync(this.rawPath);
    fs.writeFileSync(this.wavPath, Buffer.concat([header, raw]));
    fs.unlinkSync(this.rawPath);

    return this.wavPath;
  }

  private buildWavHeader(dataBytes: number): Buffer {
    const byteRate = config.sampleRate * this.channelCount * BYTES_PER_SAMPLE;
    const blockAlign = this.channelCount * BYTES_PER_SAMPLE;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(this.channelCount, 22);
    header.writeUInt32LE(config.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34); // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(dataBytes, 40);

    return header;
  }
}
