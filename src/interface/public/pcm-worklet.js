// Captures mic input and converts it to Int16 PCM chunks for Gemini Live's
// voice chat/practice — the AudioContext that registers this is created at
// 16kHz (matching config.sampleRate exactly, same as SoxCapture's existing
// output format), so no resampling happens anywhere in this pipeline.
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~8 messages/sec at 16kHz — small enough for low latency, large enough not to spam postMessage.
    this.buffer = new Int16Array(2048);
    this.writeIndex = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        const clamped = Math.max(-1, Math.min(1, channel[i]));
        this.buffer[this.writeIndex++] = clamped < 0 ? clamped * 32768 : clamped * 32767;
        if (this.writeIndex >= this.buffer.length) this.flush();
      }
    }
    return true;
  }

  flush() {
    if (this.writeIndex === 0) return;
    const chunk = this.buffer.slice(0, this.writeIndex); // fresh, own ArrayBuffer — safe to transfer
    this.port.postMessage(chunk.buffer, [chunk.buffer]);
    this.writeIndex = 0;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
