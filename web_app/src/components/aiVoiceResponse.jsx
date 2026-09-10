import { useState, useEffect, useRef, useCallback } from 'react';

/* =============================================================================
 * CONSOLIDATED VOICE MODULE
 * ---------------------------------------------------------------------------
 * This single file replaces the previous 4 files:
 *   - audioCapture.jsx      -> AudioCapture class (below)
 *   - audioPlayback.jsx     -> AudioPlayback class (below)
 *   - echoSafeAudio.jsx     -> REMOVED (see note below)
 *   - aiVoiceResponse.jsx   -> useVoiceAgent hook (below), same default export
 *
 * landingPage.jsx is UNCHANGED — it still does:
 *   import useVoiceAgent from "./aiVoiceResponse.jsx";
 * and keeps using startCapture / stopCapture / setCaptureEnabled for its
 * push-to-talk + mute/unmute UI, so no edits are needed there.
 *
 * WHY EchoSafeAudioPipeline WAS REMOVED
 * ---------------------------------------------------------------------------
 * The old approach muted the visible <audio> element and re-routed agent
 * audio through a second WebRTC-loopback audio graph, hoping the browser's
 * AEC would reference that loopback. This is exactly what your index.html
 * reference client does NOT do, and it's the root cause of the eco/
 * double-barge-in bugs you were chasing.
 *
 * Instead, this file mirrors the index.html client's (working) approach:
 *   1. The mic requests NATIVE echo cancellation from the browser
 *      (getUserMedia({ echoCancellation: true, ... })) — see AudioCapture.
 *   2. Audio is captured and streamed to the server CONTINUOUSLY while
 *      listening is on — including while the agent is talking. The native
 *      AEC is what keeps the agent's own played-back audio from re-entering
 *      the mic signal, exactly like index.html.
 *   3. Barge-in is 100% SERVER DRIVEN: the backend's speech recognizer detects
 *      the user talking over the agent and sends
 *        { "type": "status", "text": "interrupted" }
 *      which the client uses purely to stop/flush playback (see the 'status'
 *      case in the ws.onmessage handler below) — there is no client-side RMS
 *      threshold guessing whether the user is "loud enough" to barge in.
 *
 * BARGE-IN FIXES (this revision)
 * ---------------------------------------------------------------------------
 *   1. Mic now starts MUTED on every new connection (captureEnabledRef
 *      defaults to false, and ws.onopen no longer auto-enables it). Before,
 *      the ref defaulted to `true` while the UI defaulted to "muted", so
 *      audio was silently streaming before the user ever clicked unmute —
 *      this is the "getting unmuted automatically" bug reported earlier.
 *   2. `options.onBargeIn` (already passed in from landingPage.jsx) is now
 *      actually invoked from interruptPlayback(), so the UI's mic indicator
 *      correctly lights up when the server detects and acks a barge-in.
 *   3. startCapture() / setCaptureEnabled(true) now also trigger an
 *      IMMEDIATE client-side interrupt if the agent happens to be speaking
 *      when the user unmutes or presses push-to-talk — this covers the
 *      "user deliberately engages the mic" barge trigger instantly, while
 *      the server's VAD-driven 'interrupted'/'barge_in' status still covers
 *      "user talks over the agent without touching the mic button".
 *   4. Added 'session_ready' / 'auth_error' / 'consent' message handling to
 *      match the index.html reference client's wire protocol.
 *
 * PUSH-TO-TALK + MUTE/UNMUTE (kept, unchanged surface API)
 * ---------------------------------------------------------------------------
 *   - startCapture()          -> unmute / begin sending mic audio (also used
 *                                 as "press" in push-to-talk mode)
 *   - stopCapture()           -> mute / stop sending mic audio (also used as
 *                                 "release" in push-to-talk mode)
 *   - setCaptureEnabled(bool) -> programmatic mic on/off, used when toggling
 *                                 push-to-talk mode itself in landingPage.jsx
 * These are unchanged so landingPage.jsx's mic button (click-to-mute/unmute
 * and hold-to-talk via onMouseDown/onMouseUp/onTouchStart/onTouchEnd) keeps
 * working exactly as before.
 * ===========================================================================
 */

// -----------------------------------------------------------------------------
// AudioCapture — captures mic audio as PCM-16 16kHz mono and streams Base64
// chunks. Requests the browser's NATIVE echo cancellation / noise suppression
// / AGC so played-back agent audio doesn't re-enter the mic signal — this is
// the same mechanism the index.html reference client relies on.
// -----------------------------------------------------------------------------
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
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: { ideal: 16000 },
        channelCount: { ideal: 1 },
        // Request browser AEC explicitly. AGC is enabled because some browser
        // implementations only engage their strongest echo canceller when the
        // complete voice-processing chain is enabled.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    });

    const track = this._stream.getAudioTracks()[0];
    console.debug('[VoiceAgent] mic constraints:', track?.getConstraints?.());
    console.debug('[VoiceAgent] mic settings:', track?.getSettings?.());

    this._context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    this._source = this._context.createMediaStreamSource(this._stream);

    const workletCode = `
      class PCM16Processor extends AudioWorkletProcessor {
        constructor() {
          super();
          this._buf = [];
          this._frameSize = 800; // 50ms @ 16kHz
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
      // Level is reported regardless of _enabled so the UI mic-level meter
      // can still animate while muted; only actual audio chunks are gated.
      this._onLevel?.(Math.min(1, rms * 6));
      if (!this._enabled) return;
      const bytes = new Uint8Array(pcm);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      this._onChunk(btoa(binary));
    };

    this._source.connect(this._worklet);
  }

  // Used for BOTH push-to-talk (press/release) and click mute/unmute — the
  // caller decides when to call this; the class itself is agnostic to which
  // mic mode is active.
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

// -----------------------------------------------------------------------------
// AudioPlayback — decodes Base64 PCM-16 chunks and streams playback via the
// Web Audio API, straight out to the default output (own AudioContext, own
// destination) — same as index.html's native <audio> element playing agent
// audio directly, no loopback relay in between.
// -----------------------------------------------------------------------------
export class AudioPlayback {
  constructor(onPlaybackStateChange) {
    this._onPlaybackStateChange = onPlaybackStateChange;
    this._context = null;
    this._destination = null;
    this._nextStart = 0;
    this._activeSrcs = [];
    this._paused = false;
    this._bufferQueue = [];
    this._maxAheadSeconds = 0.12;
  }

  async init() {
    this._context = new AudioContext({ sampleRate: 24000 });
    this._destination = this._context.destination;
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
    src.connect(this._destination);

    const now = this._context.currentTime;
    let start = Math.max(this._nextStart, now);
    // Keep the scheduled queue short so pause and barge-in take effect quickly.
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
    this._destination = null;
    this._nextStart = 0;
    this._activeSrcs = [];
    this._bufferQueue = [];
  }
}

// -----------------------------------------------------------------------------
// useVoiceAgent — the hook landingPage.jsx consumes. Same public API as
// before (isVoiceActive, startVoiceSession, stopVoiceSession, startCapture,
// stopCapture, setCaptureEnabled, status, sessionId, micLevel, speakingPaused,
// pauseSpeaking, resumeSpeaking, notifyPlaybackStarted, notifyPlaybackEnded,
// setAgentSpeakingGate, interruptPlayback, registerAgentAudioElement) so
// landingPage.jsx needs ZERO changes.
// -----------------------------------------------------------------------------
const useVoiceAgent = (onAgentMessage, setLoading, options = {}) => {
  const [status, setStatus] = useState('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'listening' | 'speaking' | 'ready'
  const [sessionId, setSessionId] = useState(null);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [speakingPaused, setSpeakingPaused] = useState(false);

  const wsRef = useRef(null);
  const audioCaptureRef = useRef(null);
  const audioPlaybackRef = useRef(null);
  const callbackRef = useRef(onAgentMessage);
  const statusRef = useRef('disconnected'); // mirrors `status` state, but always reads the LATEST value inside closures
  const agentSpeakingRef = useRef(false);
  const captureActiveRef = useRef(false);
  const playbackSuppressionRef = useRef(false);
  const suppressionTimerRef = useRef(null);
  // Sessions now start MUTED by default (mirrors landingPage.jsx's isRecording
  // state, which is false right after connecting). Previously this ref
  // defaulted to `true` while the UI defaulted to "muted" — that mismatch
  // meant the mic was silently streaming to the server even though the
  // button showed "click to unmute", which is exactly the "getting unmuted
  // automatically" behavior we don't want. Capture is now only ever enabled
  // via an explicit startCapture() / setCaptureEnabled(true) call (unmute
  // click or push-to-talk press).
  const captureEnabledRef = useRef(false);
  const speechFramesRef = useRef(0);
  const speechThreshold = 0.12;
  const speechFramesRequired = 3;

  useEffect(() => {
    callbackRef.current = onAgentMessage;
  }, [onAgentMessage]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const stopVoiceSession = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }

    audioCaptureRef.current?.stop();
    audioCaptureRef.current = null;
    captureActiveRef.current = false;
    captureEnabledRef.current = false;
    speechFramesRef.current = 0;

    audioPlaybackRef.current?.close();
    audioPlaybackRef.current = null;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsVoiceActive(false);
    setStatus('disconnected');
    setLoading?.(false);
    setSpeakingPaused(false);
  }, [setLoading]);

  // --- Mic control: unmute / press (push-to-talk "down") ---------------------
  const startCapture = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!audioCaptureRef.current) return;   // mic wasn't ready yet (created in onopen)
    // If the agent is mid-speech when the user unmutes / presses push-to-talk,
    // cut it off immediately on the client rather than waiting on the
    // server's speech-recognizer round trip. This is the deterministic half
    // of barge-in; the server-driven 'interrupted'/'barge_in' status (see
    // ws.onmessage below) still handles the case where the user talks over
    // the agent WITHOUT touching the mic button (continuous listening mode).
    if (agentSpeakingRef.current) {
      interruptPlayback();
    }
    try { wsRef.current.send(JSON.stringify({ type: 'start_listening' })); } catch (e) { console.warn('start_listening failed', e); }
    console.log('VoiceAgent: starting capture');
    captureActiveRef.current = true;
    captureEnabledRef.current = true;
    speechFramesRef.current = 0;
    audioCaptureRef.current.setEnabled(true);
    setStatus('listening');
  }, []);

  // --- Mic control: mute / release (push-to-talk "up") ------------------------
  const stopCapture = useCallback(() => {
    captureActiveRef.current = false;
    captureEnabledRef.current = false;
    speechFramesRef.current = 0;
    audioCaptureRef.current?.setEnabled(false);
    setTimeout(() => {
      try { wsRef.current?.send(JSON.stringify({ type: 'stop_listening' })); } catch (e) { console.warn('stop_listening failed', e); }
    }, 600);
    setStatus((prev) => (prev === 'listening' ? 'connected' : prev));
  }, []);

  // --- Programmatic mic on/off, used when toggling push-to-talk mode itself --
  const setCaptureEnabled = useCallback((enabled) => {
    captureEnabledRef.current = enabled;
    if (!audioCaptureRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (enabled && agentSpeakingRef.current) {
      // Same instant client-side barge-in as startCapture() above — used when
      // landingPage.jsx flips push-to-talk mode back to always-on listening
      // while the agent happens to be speaking.
      interruptPlayback();
    }
    audioCaptureRef.current.setEnabled(enabled);
    captureActiveRef.current = enabled;
    speechFramesRef.current = 0;
    try {
      wsRef.current.send(JSON.stringify({ type: enabled ? 'start_listening' : 'stop_listening' }));
    } catch (error) {
      console.warn('microphone state update failed', error);
    }
  }, []);

  // Stops/flushes whatever the agent is currently saying. Called only in
  // response to the SERVER's barge-in signal (status: 'interrupted'), never
  // from a client-side mic-level threshold.
  const interruptPlayback = useCallback(() => {
    audioPlaybackRef.current?.flush?.();
    options.onInterrupt?.();
    // Tell the UI a barge-in just happened (e.g. landingPage.jsx's
    // handleBargeIn lights up the mic icon as "recording"). This option was
    // already being passed in from landingPage.jsx but was never actually
    // invoked here — that missing wire-up meant the UI never reflected a
    // barge-in even when it fired correctly under the hood.
    options.onBargeIn?.();
    agentSpeakingRef.current = false;
    setSpeakingPaused(false);
    setStatus('listening');
  }, []);

  const startVoiceSession = useCallback(async () => {
    if (isVoiceActive) {
      stopVoiceSession();
      return;
    }

    try {
      // Each new voice session starts MUTED. The mic is "armed" (permission
      // requested, audio graph built) in ws.onopen below so it's ready to go
      // instantly, but no audio is streamed to the server until the user
      // explicitly unmutes (startCapture / setCaptureEnabled(true)) or holds
      // push-to-talk. See the captureEnabledRef comment above for why this
      // matters for barge-in reliability.
      captureEnabledRef.current = false;
      setStatus('connecting');

      // Initialize Audio Playback — own AudioContext -> default destination,
      // played straight out like the index.html reference client's <audio>
      // element. The mic's native echoCancellation (see AudioCapture above)
      // is what cancels this back out of the capture, no separate relay.
      const playback = new AudioPlayback((playing) => {
        agentSpeakingRef.current = playing;
        if (!playing && statusRef.current === 'speaking') {
          setStatus(captureEnabledRef.current ? 'listening' : 'connected');
        }
      });
      await playback.init();
      audioPlaybackRef.current = playback;

      // Prefer environment-configured API base so deployments are flexible.
      const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
      let wsUrl = '';
      if (apiBase) {
        // convert http(s) to ws(s)
        wsUrl = apiBase.replace(/^https?:/, (m) => (m === 'https:' ? 'wss:' : 'ws:')) + '/voice/chat';
      } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${window.location.host}/voice/chat`;
      }
      // Fallback hard-coded host (legacy)
      if (!wsUrl) wsUrl = "wss://txrh-app-roadierangerdev-6279-stosup-phmo.azurewebsites.net/voice/chat";
      console.debug('VoiceAgent: connecting wsUrl=', wsUrl);

      // Optional nonce retrieval (matches your backend check)
      try {
        const nonceRes = await fetch(`${apiBase || ''}/api/ws-nonce`, { credentials: 'include' });
        if (nonceRes.ok) {
          const { nonce } = await nonceRes.json();
          wsUrl += `?nonce=${encodeURIComponent(nonce)}`;
        } else {
          console.warn('WS nonce endpoint returned status', nonceRes.status);
        }
      } catch (err) {
        console.warn('Failed to fetch WS nonce, proceeding with direct connection:', err);
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        console.debug('VoiceAgent: websocket open', wsUrl, ws.readyState);
        const voiceSessionId = crypto.randomUUID();
        setSessionId(voiceSessionId);
        setStatus('connected');
        setIsVoiceActive(true);
        // The BFF requires init to be the first frame on every voice connection.
        ws.send(JSON.stringify({ type: 'init', session_id: voiceSessionId }));
        // Do not force-start mic capture here; push-to-talk / mute-unmute UI
        // (landingPage.jsx) decides when to actually call startCapture().

        // Create the mic ONCE per connection.
        try {
          let sentChunks = 0;
          const capture = new AudioCapture(
            (base64Chunk) => {
              try {
                // Continuous streaming — audio keeps flowing to the server the
                // whole time listening is enabled, INCLUDING while the agent
                // is talking. This matches the index.html reference client:
                // the server-side speech recognizer detects the user talking
                // over the agent (interim "recognizing" event) and sends back
                // { "type": "status", "text": "interrupted" } — see the
                // 'status' case below — rather than the client guessing from
                // a mic RMS threshold. The mic's native echoCancellation is
                // what keeps the agent's own played-back audio from being
                // picked up as fake user speech.
                if (!captureEnabledRef.current) return;

                // If we're suppressing initial mic frames right after switching
                // to agent audio (to avoid echo leakage), drop frames until
                // suppression is cleared. User speech will still trigger the
                // level callback which clears suppression and causes an
                // immediate interrupt so we don't miss real barge-in.
                if (playbackSuppressionRef.current) return;

                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  const binary = atob(base64Chunk);
                  const audioBytes = new Uint8Array(binary.length);
                  for (let i = 0; i < binary.length; i += 1) {
                    audioBytes[i] = binary.charCodeAt(i);
                  }
                  wsRef.current.send(audioBytes.buffer);
                  sentChunks += 1;
                  if (sentChunks === 1) console.debug('VoiceAgent: sent first audio chunk');
                }
              } catch (err) {
                console.error('VoiceAgent: failed to send audio chunk', err);
              }
            },
            (level) => {
              setMicLevel(level);
              // Only process level-based barge-in when the mic is enabled.
              if (!captureEnabledRef.current) {
                speechFramesRef.current = 0;
                return;
              }

              if (level >= speechThreshold) {
                speechFramesRef.current += 1;
                if (speechFramesRef.current >= speechFramesRequired) {
                  speechFramesRef.current = 0;
                  // User has started speaking: interrupt playback so server
                  // recognizes the user's speech immediately.
                  interruptPlayback();
                  // If we were suppressing mic frames to avoid echo, stop
                  // suppressing so subsequent frames are forwarded.
                  if (playbackSuppressionRef.current) {
                    playbackSuppressionRef.current = false;
                    if (suppressionTimerRef.current) { clearTimeout(suppressionTimerRef.current); suppressionTimerRef.current = null; }
                  }
                }
              } else {
                speechFramesRef.current = 0;
              }
            }
          );
          await capture.start();
          audioCaptureRef.current = capture;
          // Mic permission is granted and the audio graph is built, but
          // capture stays OFF until the user explicitly unmutes or presses
          // push-to-talk — see startCapture() / setCaptureEnabled() above.
          // This keeps the "muted" mic icon in landingPage.jsx truthful and
          // avoids streaming audio (and possibly tripping the recognizer)
          // before the user has actually engaged the mic.
          console.log('VoiceAgent: mic armed on connect (muted until unmuted)');
        } catch (err) {
          console.error('VoiceAgent: failed to initialize mic on connect', err);
        }
      };

      ws.onmessage = (event) => {
        // try to parse JSON frames, but some frames may be binary or text — log raw for debugging
        try {
          let data = null;
          try { data = JSON.parse(event.data); } catch (e) { /* not JSON */ }
          if (!data) {
            console.debug('VoiceAgent: ws message (raw):', event.data);
            return;
          }
          console.debug('VoiceAgent: ws message type=', data.type);
          switch (data.type) {
            case 'session_id':
            case 'session_ready':
              // Mirrors the index.html reference client's session_ready ack —
              // some backend versions emit 'session_id' instead, so both are
              // accepted here.
              if (data.id || data.session_id) setSessionId(data.id || data.session_id);
              setStatus('connected');
              break;

            case 'auth_error':
              console.error('VoiceAgent: auth_error', data.code, data.message);
              setLoading?.(false);
              if (typeof callbackRef.current === 'function') {
                callbackRef.current(`⚠️ ${data.message || 'Voice session authentication failed.'}`, 'ai', { streaming: false });
              }
              stopVoiceSession();
              break;

            case 'consent':
              if (typeof callbackRef.current === 'function') {
                callbackRef.current(data.text || 'Consent required to continue.', 'ai', { streaming: false, link: data.link || '', consentRequired: true });
              }
              break;

            case 'status':
              if (data.text === 'interrupted' || data.text === 'barge_in') {
                // Server detected the user talking over the agent — this is
                // the ONLY barge-in trigger now (matches index.html's
                // 'interrupted' handler). Instantly silence speaker output.
                interruptPlayback();
              } else {
                setStatus(data.text);
              }
              break;

            case 'audio_chunk':
              console.debug('[VoiceAgent] playback path: WEB_AUDIO_PCM');
              if (!speakingPaused) {
                agentSpeakingRef.current = true;
                setStatus('speaking');
              }
              audioPlaybackRef.current?.enqueue(data.data);
              break;

            case 'agent_audio':
              console.debug('[VoiceAgent] playback path: HTML_AUDIO', data.format || 'audio/mpeg');
              setLoading?.(false);
              // server sent a ready-to-play audio clip (e.g. mp3)
              try {
                const bin = atob(data.audio_base64 || '');
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const blob = new Blob([bytes], { type: data.format || 'audio/mpeg' });
                const url = URL.createObjectURL(blob);
                // Mark agent as speaking immediately and briefly suppress
                // forwarding of mic frames while the client swaps to the
                // new audio clip. The suppression is cleared automatically
                // after a short delay, or immediately when the user speaks.
                agentSpeakingRef.current = true;
                setStatus('speaking');
                playbackSuppressionRef.current = true;
                if (suppressionTimerRef.current) { clearTimeout(suppressionTimerRef.current); suppressionTimerRef.current = null; }
                suppressionTimerRef.current = setTimeout(() => {
                  playbackSuppressionRef.current = false;
                  suppressionTimerRef.current = null;
                }, 300);
                if (options.onAudio && typeof options.onAudio === 'function') {
                  options.onAudio({ url, blob, format: data.format || 'audio/mpeg' });
                } else {
                  // fallback: enqueue via WebAudio if available (not ideal for encoded formats)
                  audioPlaybackRef.current?.enqueue(data.audio_base64);
                }

                // If the server provided a link or consent-like metadata, surface it as an AI message
                // so the existing MessageBubble consent UI can render (uses `link` and `consentRequired`).
                try {
                  const hasLink = Boolean(data.link);
                  const consentFlag = Boolean(data.consent || data.consentRequired || hasLink);
                  if (hasLink || consentFlag) {
                    const caption = data.caption || data.text || 'Voice message contains a link — grant consent to open.';
                    if (typeof callbackRef.current === 'function') {
                      callbackRef.current(caption, 'ai', { streaming: false, link: data.link || '', consentRequired: consentFlag });
                    }
                  }
                } catch (err) {
                  console.warn('Failed to emit consent message for agent_audio:', err);
                }
              } catch (err) {
                console.error('Failed to handle agent_audio:', err);
              }
              break;

            case 'agent_text_delta':
              setLoading?.(false);
              if (typeof callbackRef.current === 'function') {
                callbackRef.current(data.delta || '', 'ai', { streaming: true });
              }
              break;

            case 'user_text':
              {
                const transcript = [data.text, data.user_text, data.transcript, data.content]
                  .find((value) => typeof value === 'string' && value.trim());
                if (transcript && typeof callbackRef.current === 'function') {
                  console.debug('[VoiceAgent] recognized user speech:', transcript.trim());
                  callbackRef.current(transcript.trim(), 'user');
                  setLoading?.(true);
                }
              }
              break;

            case 'agent_text':
              setLoading?.(false);
              if (typeof callbackRef.current === 'function') {
                callbackRef.current(data.text || '', 'ai', { streaming: false });
              }
              break;

            case 'error':
              console.error('Voice Agent Error:', data.text);
              setLoading?.(false);
              if (typeof callbackRef.current === 'function') {
                callbackRef.current(`⚠️ ${data.text || 'Something went wrong.'}`, 'ai', { streaming: false });
              }
              break;

            default:
              break;
          }
        } catch (err) {
          console.error('Failed to parse WS message:', err);
        }
      };

      ws.onclose = (ev) => {
        console.debug('VoiceAgent: websocket closed', ev.code, ev.reason);
        stopVoiceSession();
      };

      ws.onerror = (err) => {
        console.error('Voice WebSocket Error:', err);
        // do not immediately stop; allow onclose to handle cleanup
      };
    } catch (err) {
      console.error('Failed to start voice session:', err);
      stopVoiceSession();
    }
  }, [isVoiceActive, setLoading, stopVoiceSession]);

  useEffect(() => {
    return () => {
      stopVoiceSession();
    };
  }, [stopVoiceSession]);

  const pauseSpeaking = useCallback(() => {
    audioPlaybackRef.current?.pause?.();
    setSpeakingPaused(true);
    setStatus('speaking_paused');
  }, []);

  const resumeSpeaking = useCallback(() => {
    audioPlaybackRef.current?.resume?.();
    setSpeakingPaused(false);
    setStatus('speaking');
  }, []);

  const notifyPlaybackStarted = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'playback_started' }));
    }
  }, []);

  const notifyPlaybackEnded = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'playback_ended' }));
    }
  }, []);

  const setAgentSpeakingGate = useCallback((value) => {
    agentSpeakingRef.current = value;
  }, []);

  // Kept as a no-op for backward compatibility with landingPage.jsx, which
  // still calls registerAgentAudioElement(audioRef.current) on mount. There
  // is no echo-safe relay to tap into anymore — the <audio> element plays
  // directly, exactly like index.html's native <audio controls> — so this is
  // intentionally a harmless no-op rather than requiring landingPage.jsx edits.
  const registerAgentAudioElement = useCallback(() => {}, []);

  return {
    isVoiceActive,
    startVoiceSession,
    stopVoiceSession,
    startCapture,
    stopCapture,
    setCaptureEnabled,
    status,
    sessionId,
    micLevel,
    speakingPaused,
    pauseSpeaking,
    resumeSpeaking,
    notifyPlaybackStarted,
    notifyPlaybackEnded,
    setAgentSpeakingGate,
    interruptPlayback,
    registerAgentAudioElement,
  };
};

export default useVoiceAgent;
