// Decodes Base64 PCM-16/MP3 chunks and streams playback via Web Audio API.
// Output is routed through a MediaStreamAudioDestinationNode and played via a hidden
// <audio> element so Chromium's native AEC engine can reference output and cancel it out of the mic.
export class AudioPlayback {
  constructor(onPlaybackStateChange) {
    this._onPlaybackStateChange = onPlaybackStateChange;
    this._context = null;
    this._destination = null;
    this._streamDestination = null;
    this._audioEl = null;
    this._nextStart = 0;
    this._activeSrcs = [];
    this._paused = false;
    this._bufferQueue = [];
    this._maxAheadSeconds = 0.12;
  }

  async init() {
    // 16 kHz AudioContext to align with AudioCapture and maintain sample clock sync for AEC
    this._context = new AudioContext({ sampleRate: 16000 });

    this._streamDestination = this._context.createMediaStreamDestination();
    this._destination = this._streamDestination;

    this._audioEl = document.createElement('audio');
    this._audioEl.autoplay = true;
    this._audioEl.muted = false;
    this._audioEl.srcObject = this._streamDestination.stream;

    this._audioEl.style.position = 'fixed';
    this._audioEl.style.width = '0';
    this._audioEl.style.height = '0';
    this._audioEl.style.opacity = '0';
    this._audioEl.style.pointerEvents = 'none';
    document.body.appendChild(this._audioEl);

    try {
      await this._audioEl.play();
    } catch (err) {
      console.warn('[VoiceAgent] agent <audio> element play() was blocked:', err);
    }

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

    const buf = this._context.createBuffer(1, float32.length, 16000);
    buf.copyToChannel(float32, 0);

    const src = this._context.createBufferSource();
    src.buffer = buf;
    src.connect(this._destination);

    const now = this._context.currentTime;
    let start = Math.max(this._nextStart, now);

    if (start - now > this._maxAheadSeconds) {
      this.flush();
      start = this._context.currentTime;
    }

    src.start(start);
    this._nextStart = start + buf.duration;

    this._activeSrcs.push(src);
    this._onPlaybackStateChange?.(true);

    src.onended = () => {
      const idx = this._activeSrcs.indexOf(src);
      if (idx !== -1) this._activeSrcs.splice(idx, 1);
      if (this._activeSrcs.length === 0 && this._bufferQueue.length === 0) {
        this._onPlaybackStateChange?.(false);
      }
    };
  }

  flush() {
    if (!this._context) return;
    for (const src of this._activeSrcs) {
      try { src.stop(); } catch (_) {}
    }
    this._activeSrcs = [];
    this._bufferQueue = [];
    this._nextStart = this._context.currentTime;
    this._onPlaybackStateChange?.(false);
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
    if (this._audioEl) {
      try {
        this._audioEl.pause();
        this._audioEl.srcObject = null;
        if (this._audioEl.parentNode) this._audioEl.parentNode.removeChild(this._audioEl);
      } catch (_) {}
    }
    this._audioEl = null;
    this._streamDestination = null;
    this._context = null;
    this._destination = null;
    this._nextStart = 0;
    this._activeSrcs = [];
    this._bufferQueue = [];
    this._onPlaybackStateChange?.(false);
  }
}