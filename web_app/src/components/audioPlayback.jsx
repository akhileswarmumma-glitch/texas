// Decodes Base64 PCM-16 chunks and streams playback via Web Audio API.
export class AudioPlayback {
  constructor() {
    this._context = null;
    this._nextStart = 0;
    this._activeSrcs = [];
    this._paused = false;
    this._bufferQueue = [];
  }

  async init() {
    this._context = new AudioContext({ sampleRate: 24000 });
    this._nextStart = this._context.currentTime;
    this._activeSrcs = [];
  }

  enqueue(base64) {
    if (!this._context) return;

    if (this._paused) {
      this._bufferQueue.push(base64);
      return;
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    }

    const buf = this._context.createBuffer(1, float32.length, 24000);
    buf.copyToChannel(float32, 0);

    const src = this._context.createBufferSource();
    src.buffer = buf;
    src.connect(this._context.destination);

    const now = this._context.currentTime;
    const start = Math.max(this._nextStart, now);
    src.start(start);
    this._nextStart = start + buf.duration;

    this._activeSrcs.push(src);
    src.onended = () => {
      const idx = this._activeSrcs.indexOf(src);
      if (idx !== -1) this._activeSrcs.splice(idx, 1);
    };
  }

  flush() {
    if (!this._context) return;
    for (const src of this._activeSrcs) {
      try { src.stop(); } catch (_) {}
    }
    this._activeSrcs = [];
    this._nextStart = this._context.currentTime;
  }

  pause() {
    if (!this._context) return;
    this._paused = true;
    this.flush();
  }

  resume() {
    if (!this._context) return;
    this._paused = false;
    while (this._bufferQueue.length > 0) {
      const base64 = this._bufferQueue.shift();
      try { this.enqueue(base64); } catch (_) {}
    }
  }

  close() {
    this._context?.close();
    this._context = null;
    this._nextStart = 0;
    this._activeSrcs = [];
  }
}