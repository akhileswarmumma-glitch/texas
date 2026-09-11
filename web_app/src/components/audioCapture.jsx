// Captures mic audio as PCM-16 16 kHz mono and streams Base64 chunks.
// Requests browser native Echo Cancellation (AEC) so agent playback is subtracted.
export class AudioCapture {
  constructor(onChunk, onLevel) {
    this._onChunk = onChunk;
    this._onLevel = onLevel;
    this._context = null;
    this._source = null;
    this._worklet = null;
    this._stream = null;
    this._enabled = false;
  }

  async start() {
    // Request mic access with native AEC, noise suppression, and AGC
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Force Web Audio Context to resample mic stream to clean 16 kHz mono PCM
    this._context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    this._source = this._context.createMediaStreamSource(this._stream);

    const workletCode = `
      class PCM16Processor extends AudioWorkletProcessor {
        constructor() {
          super();
          this._buf = [];
          this._frameSize = 800; // Exactly 50ms @ 16kHz
        }
        process(inputs) {
          const ch = inputs[0]?.[0];
          if (!ch) return true;
          for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);
          while (this._buf.length >= this._frameSize) {
            const frame = this._buf.splice(0, this._frameSize);
            const pcm = new Int16Array(frame.length);
            let sum = 0;
            for (let i = 0; i < frame.length; i++) {
              const s = Math.max(-1, Math.min(1, frame[i]));
              pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
              sum += Math.abs(frame[i]);
            }
            const rms = sum / frame.length;
            this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
          }
          return true;
        }
      }
      registerProcessor('pcm16-processor', PCM16Processor);
    `;

    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this._context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this._worklet = new AudioWorkletNode(this._context, 'pcm16-processor');
    this._worklet.port.onmessage = (ev) => {
      const { pcm, rms } = ev.data;
      this._onLevel?.(Math.min(1, rms * 6));
      if (!this._enabled) return;

      const bytes = new Uint8Array(pcm);
      let binary = '';
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      this._onChunk(btoa(binary));
    };

    this._source.connect(this._worklet);
  }

  setEnabled(value) {
    this._enabled = value;
  }

  stop() {
    this._worklet?.disconnect();
    this._source?.disconnect();
    this._context?.close();
    this._stream?.getTracks().forEach((t) => t.stop());
    this._context = this._source = this._worklet = this._stream = null;
  }
}