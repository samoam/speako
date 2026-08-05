import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { config } from '../config';

/**
 * Captures audio via SoX (external binary, must be installed and on PATH).
 *
 * With both MIC_AUDIO_DEVICE and SYSTEM_AUDIO_DEVICE set, uses SoX's `-M` merge
 * mode to read both waveaudio devices in a single process and interleave them
 * into one 2-channel PCM stream (channel 0 = mic, channel 1 = system/loopback).
 * Reading both devices in one process keeps them sample-aligned; two independent
 * SoX processes would drift relative to each other over time.
 *
 * System audio loopback is not a real input device on Windows by default — see
 * NOTES.md for setup (Stereo Mix or a virtual audio cable).
 */
export class SoxCapture extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;

  get channelCount(): number {
    return config.systemDevice ? 2 : 1;
  }

  start(): void {
    const args = this.buildArgs();
    this.proc = spawn(config.soxBinary, args);

    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });

    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.emit('log', text);
    });

    this.proc.on('error', (err) => {
      this.emit(
        'error',
        new Error(`Failed to start SoX (checked "${config.soxBinary}" — set SOX_BINARY in .env if it's not on PATH): ${err.message}`)
      );
    });

    this.proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.emit('error', new Error(`SoX exited unexpectedly with code ${code}`));
      }
      this.emit('close', code);
    });
  }

  stop(): void {
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
  }

  private buildArgs(): string[] {
    const rate = String(config.sampleRate);

    if (config.systemDevice) {
      return [
        '-M',
        '-c', '1', '-r', rate, '-t', 'waveaudio', config.micDevice,
        '-c', '1', '-r', rate, '-t', 'waveaudio', config.systemDevice,
        '-r', rate, '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-',
      ];
    }

    return [
      '-c', '1', '-r', rate, '-t', 'waveaudio', config.micDevice,
      '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-',
    ];
  }
}
