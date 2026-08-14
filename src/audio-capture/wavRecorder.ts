import * as fs from 'fs';
import { config } from '../config';
import { buildWavHeader } from './wavHeader';

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

    const header = buildWavHeader(this.bytesWritten, config.sampleRate, this.channelCount);
    const raw = fs.readFileSync(this.rawPath);
    fs.writeFileSync(this.wavPath, Buffer.concat([header, raw]));
    fs.unlinkSync(this.rawPath);

    return this.wavPath;
  }
}
