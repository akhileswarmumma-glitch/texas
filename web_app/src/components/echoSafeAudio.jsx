// echoSafeAudio.js
export class EchoSafeAudioPipeline {
  constructor() {
    this.context = null;
    this.destination = null; // MediaStreamAudioDestinationNode — connect all agent audio here
    this._pc1 = null;
    this._pc2 = null;
    this._outputEl = null;
    this._initPromise = null;
    this._tappedElements = new WeakSet();
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      this.context = new AudioContext({ sampleRate: 24000 });
      this.destination = this.context.createMediaStreamDestination();

      this._pc1 = new RTCPeerConnection();
      this._pc2 = new RTCPeerConnection();

      this._pc1.onicecandidate = (e) => {
        if (e.candidate) this._pc2.addIceCandidate(e.candidate).catch(() => {});
      };
      this._pc2.onicecandidate = (e) => {
        if (e.candidate) this._pc1.addIceCandidate(e.candidate).catch(() => {});
      };

      this._outputEl = document.createElement('audio');
      this._outputEl.autoplay = true;
      this._outputEl.style.display = 'none';
      document.body.appendChild(this._outputEl);

      this._pc2.ontrack = (event) => {
        this._outputEl.srcObject = event.streams[0];
        const p = this._outputEl.play();
        if (p && p.catch) p.catch((err) => console.warn('EchoSafeAudioPipeline: autoplay blocked', err));
      };

      this.destination.stream.getAudioTracks().forEach((track) => {
        this._pc1.addTrack(track, this.destination.stream);
      });

      const offer = await this._pc1.createOffer();
      await this._pc1.setLocalDescription(offer);
      await this._pc2.setRemoteDescription(offer);
      const answer = await this._pc2.createAnswer();
      await this._pc2.setLocalDescription(answer);
      await this._pc1.setRemoteDescription(answer);
    })();
    return this._initPromise;
  }

  tapElement(audioEl) {
    if (!audioEl || !this.context || this._tappedElements.has(audioEl)) return;
    try {
      const source = this.context.createMediaElementSource(audioEl);
      source.connect(this.destination);
      audioEl.muted = true; // all audible output now goes through the relay only
      this._tappedElements.add(audioEl);
    } catch (err) {
      console.warn('EchoSafeAudioPipeline: failed to tap audio element', err);
    }
  }

  dispose() {
    try { this._pc1?.close(); } catch (_) {}
    try { this._pc2?.close(); } catch (_) {}
    this._pc1 = null;
    this._pc2 = null;
    if (this._outputEl) {
      this._outputEl.pause();
      this._outputEl.srcObject = null;
      this._outputEl.remove();
      this._outputEl = null;
    }
    this.context?.close();
    this.context = null;
    this.destination = null;
    this._initPromise = null;
  }
}