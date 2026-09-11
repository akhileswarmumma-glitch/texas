/**
 * useVoiceChat.js
 * ============================================================================
 * Frontend VOICE FUNCTIONALITY hook for the Roadie Ranger push-to-talk / mic
 * on-off voice chat feature. This file is UI-agnostic on purpose: it owns the
 * WebSocket connection, mic capture, resampling, playback and barge-in state
 * machine, and exposes plain React state + handler functions that you wire up
 * to your EXISTING design's mic button, mute toggle, transcript panel, etc.
 *
 * It talks to the BFF relay described in voice_bff.py:
 *
 *      Browser <--ws--> BFF (/voice/chat) <--ws--> Voice backend (main.py /chat)
 *
 * Protocol summary (see voice_bff.py + main.py docstrings for full detail):
 *   1. Fetch a one-time nonce from `${apiBase}/api/ws-nonce` (credentials:
 *      'include', so the BFF session cookie rides along) and append it as a
 *      `?nonce=...` query param on the WebSocket URL BEFORE opening the
 *      socket. This is required by the deployed BFF (see "WHY THE NONCE"
 *      below) — connecting without it will get silently rejected/closed.
 *   2. Open a WebSocket to the BFF endpoint (with the nonce attached).
 *   3. The FIRST frame you send MUST be:
 *          {"type": "init", "session_id": "<uuid you generate>"}
 *   4. Once the backend session is ready you'll receive {"type":"session_ready", ...}.
 *   5. Send {"type":"start_listening"} to arm the backend's continuous
 *      recognizer, then stream raw PCM16 mono 16kHz audio as BINARY frames.
 *      The backend's own VAD decides where one utterance ends — you do not
 *      need to (and should not) chunk audio per-utterance yourself.
 *   6. Inbound JSON frames you must handle: session_ready, status
 *      (listening|thinking|synthesizing|ready|idle|interrupted), user_text,
 *      agent_text, agent_audio (base64 mp3), consent, error, auth_error, pong.
 *   7. You MUST ack playback with {"type":"playback_started"} /
 *      {"type":"playback_ended"} — the backend uses this (plus its own
 *      mid-utterance "recognizing" event) to know when a barge-in should
 *      cancel the in-flight turn / playback.
 *   8. Send {"type":"stop_listening"} to disarm the recognizer (mic off).
 *
 * ----------------------------------------------------------------------------
 * WHY THE NONCE (this is the fix for "it is not connected")
 * ----------------------------------------------------------------------------
 * An earlier revision of this hook opened the WebSocket directly against a
 * hardcoded wss:// URL with no prior handshake, on the assumption that the
 * BFF authenticates purely off the session cookie riding along with the
 * WebSocket upgrade request. In practice the deployed BFF ALSO requires a
 * short-lived, one-time nonce minted by a same-origin REST endpoint
 * (`/api/ws-nonce`) and passed back as a query parameter on the `/voice/chat`
 * URL — without it the BFF rejects/drops the connection before it ever
 * reaches session_ready, which looks to the UI like "nothing happens" (no
 * error frame, just no connection). This revision fetches that nonce first,
 * exactly like the project's own reference client does, and only then opens
 * the socket. It also now resolves the BFF base URL the same way (preferring
 * `VITE_API_BASE`, falling back to the current page's origin, and only then
 * to the hardcoded DEFAULT_WS_URL) so it works the same across environments.
 *
 * ----------------------------------------------------------------------------
 * THE TWO TRICKY REQUIREMENTS THIS FILE SOLVES
 * ----------------------------------------------------------------------------
 * A) Push-to-talk AND continuous mic on/off, together, on ONE backend session
 *    model. The backend only understands "start_listening" / "stop_listening"
 *    (a whole listening *session*, with its own VAD deciding utterance
 *    boundaries) — it has no concept of "this one button press = one
 *    utterance". So instead of starting/stopping the backend recognizer on
 *    every press (slow — a Speech SDK start/stop round trip per tap), this
 *    hook layers push-to-talk on TOP of a continuous backend session:
 *      - `enableContinuousMic()` / `disableMic()`  -> calls the backend
 *         start_listening / stop_listening exactly once per "mic on" period.
 *      - `onPTTDown()` / `onPTTUp()` -> when in push-to-talk mode, these only
 *         toggle a local, client-side gate (`shouldSendAudioRef`) that decides
 *         whether captured audio frames are actually forwarded to the socket.
 *         The backend recognizer keeps running the whole time (so the very
 *         next press is instant), it just isn't fed any audio while the
 *         button is up.
 *
 * B) "Native echo should be completely managed" + "even if the mic is on it
 *    should not capture the agent's own voice, but SHOULD still capture the
 *    user talking over it (barge-in)."
 *      - We deliberately do NOT gate/mute the mic while the agent is
 *        speaking. Barge-in detection happens server-side (Speech SDK's
 *        interim `recognizing` event) and it needs a live mic feed the whole
 *        time the agent is talking — muting locally would make barge-in
 *        impossible.
 *      - Instead we rely on the browser's NATIVE acoustic echo cancellation:
 *        getUserMedia is requested with `echoCancellation: true` (+
 *        noiseSuppression/autoGainControl), and the agent's TTS audio is
 *        played back through a normal <audio> element attached to the page.
 *        Chrome/Edge/Firefox's built-in AEC uses exactly that kind of
 *        page-rendered playback as its "reference" signal and subtracts it
 *        out of the mic input before it ever reaches getUserMedia's output
 *        track — so the recognizer only ever sees the real microphone
 *        signal (the user), not the echo of the agent's own voice, while
 *        still hearing genuine barge-in speech.
 *      - As a belt-and-suspenders extra (OFF by default — see
 *        `duckWhileAgentSpeaking` option), you can also apply a small extra
 *        gain reduction to the captured signal while the agent is speaking,
 *        to further reduce any AEC leakage without blocking real speech.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Hardcoded last-resort fallback if VITE_API_BASE isn't set AND we can't infer
// a same-origin BFF from window.location (e.g. very early SSR/build tooling).
const DEFAULT_WS_URL =
  "wss://txrh-app-roadierangerdev-6279-stosup-phmo.azurewebsites.net/voice/chat";

// Must match the backend's INPUT_SAMPLE_RATE (main.py: INPUT_SAMPLE_RATE=16000).
const TARGET_SAMPLE_RATE = 16000;

// How long to wait for {"type":"session_ready"} after opening the socket
// before treating the connection attempt as failed.
const SESSION_READY_TIMEOUT_MS = 10000;

// Keepalive interval — the backend/BFF's own websockets ping_interval is 20s;
// sending our own app-level ping keeps NAT/proxies happy and lets us surface
// "connection looks dead" to the UI.
const PING_INTERVAL_MS = 20000;

// ---------------------------------------------------------------------------
// Audio worklet (captures raw mic frames off the main thread). Loaded from a
// Blob so this whole feature stays a single importable file — no separate
// worklet .js needs to be hosted/served.
// ---------------------------------------------------------------------------
const WORKLET_SOURCE = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      // .slice(0) copies the data out — the Float32Array backing input[0] is
      // reused by the audio graph on the very next render quantum.
      this.port.postMessage(input[0].slice(0));
    }
    return true; // keep the processor alive
  }
}
registerProcessor("pcm-capture-processor", PCMCaptureProcessor);
`;

// ---------------------------------------------------------------------------
// Small audio helpers
// ---------------------------------------------------------------------------

/** Float32 [-1,1] samples -> Int16 PCM samples (what the backend expects). */
function floatTo16BitPCM(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Linear-interpolation resample down to TARGET_SAMPLE_RATE. Good enough for
 * speech recognition (the Speech SDK's own VAD/recognizer does the heavy
 * lifting) and keeps this file dependency-free. No-op if already 16kHz (which
 * it usually will be, since we ask AudioContext for that rate up front).
 */
function resampleTo16k(float32Array, inputSampleRate) {
  if (inputSampleRate === TARGET_SAMPLE_RATE) return float32Array;
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const newLength = Math.round(float32Array.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, float32Array.length - 1);
    const frac = srcIndex - i0;
    result[i] = float32Array[i0] * (1 - frac) + float32Array[i1] * frac;
  }
  return result;
}

function rmsLevel(float32Array) {
  let sum = 0;
  for (let i = 0; i < float32Array.length; i++) sum += float32Array[i] * float32Array[i];
  return Math.sqrt(sum / (float32Array.length || 1));
}

function safeUuid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  // Fallback for older browsers without crypto.randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Resolves the base HTTP(S) API origin the same way aiVoiceResponse.jsx did:
 * prefer an explicit VITE_API_BASE env var, otherwise fall back to the page's
 * own origin. Trailing slashes are stripped so callers can safely
 * string-concatenate a path.
 */
function resolveApiBase() {
  const raw = (import.meta.env && import.meta.env.VITE_API_BASE) || "";
  if (raw) return raw.replace(/\/+$/, "");
  if (typeof window !== "undefined" && window.location) {
    return `${window.location.protocol}//${window.location.host}`;
  }
  return "";
}

/** http(s):// -> ws(s):// */
function toWsProtocol(httpUrl) {
  return httpUrl.replace(/^https?:/, (m) => (m === "https:" ? "wss:" : "ws:"));
}

/**
 * Builds the final /voice/chat WebSocket URL AND fetches the one-time nonce
 * required by the BFF, appending it as a query param. Mirrors exactly what
 * the project's own working reference client (aiVoiceResponse.jsx) does:
 *   1. Prefer VITE_API_BASE (converted http->ws) for the base, else same-origin.
 *   2. Fall back to the hardcoded DEFAULT_WS_URL only if neither resolves.
 *   3. GET `${apiBase}/api/ws-nonce` with credentials: 'include' (so the BFF's
 *      session cookie is sent) and append `?nonce=...` to the URL.
 * Nonce fetch failures are logged but do NOT block the connection attempt —
 * some BFF configs may not require it — but in the common case where it IS
 * required, skipping this step is exactly why the socket silently never
 * reaches session_ready.
 */
async function buildVoiceWsUrl() {
  const apiBase = resolveApiBase();
  let wsUrl = apiBase ? `${toWsProtocol(apiBase)}/voice/chat` : "";
  if (!wsUrl) wsUrl = DEFAULT_WS_URL;

  try {
    const nonceRes = await fetch(`${apiBase || ""}/api/ws-nonce`, { credentials: "include" });
    if (nonceRes.ok) {
      const { nonce } = await nonceRes.json();
      if (nonce) {
        wsUrl += `${wsUrl.includes("?") ? "&" : "?"}nonce=${encodeURIComponent(nonce)}`;
      }
    } else {
      console.warn("[useVoiceChat] WS nonce endpoint returned status", nonceRes.status);
    }
  } catch (err) {
    console.warn("[useVoiceChat] Failed to fetch WS nonce, proceeding without it:", err);
  }

  return wsUrl;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * @param {Object} [options]
 * @param {string}  [options.wsUrl]                  Force a specific BFF endpoint,
 *        bypassing the VITE_API_BASE/same-origin resolution AND the nonce
 *        fetch entirely (use only for testing against a URL that already has
 *        everything it needs baked in).
 * @param {boolean} [options.autoConnect=false]       Open the socket on mount.
 * @param {boolean} [options.duckWhileAgentSpeaking=false]
 *        Optional extra safety net on top of native AEC: gently attenuates
 *        (does NOT mute) the captured signal while the agent is speaking.
 *        Leave off unless you still see occasional false triggers from
 *        speaker echo in your environment/headset.
 * @param {number}  [options.duckGain=0.5]            Gain applied when ducking.
 */
export function useVoiceChat(options = {}) {
  const {
    wsUrl: forcedWsUrl,
    autoConnect = false,
    duckWhileAgentSpeaking = false,
    duckGain = 0.5,
  } = options;

  // ---- Public state -------------------------------------------------------
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  // "disconnected" | "connecting" | "connected" | "error"

  const [sessionStatus, setSessionStatus] = useState("idle");
  // "idle" | "listening" | "thinking" | "synthesizing" | "ready" | "interrupted"

  const [micMode, setMicMode] = useState("off"); // "off" | "continuous" | "push-to-talk"
  const [isMicSessionActive, setIsMicSessionActive] = useState(false);
  const [isPTTHeld, setIsPTTHeld] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);

  const [userTranscript, setUserTranscript] = useState("");
  const [agentText, setAgentText] = useState("");
  const [lastResponseId, setLastResponseId] = useState(null);
  const [consent, setConsent] = useState(null); // { link, text } | null
  const [errorMessage, setErrorMessage] = useState(null);
  const [audioLevel, setAudioLevel] = useState(0); // 0..1, for a mic-level meter

  // ---- Internal refs (mirror the state above for use inside callbacks that
  // must always see the LATEST value, not a stale closure) -----------------
  const wsRef = useRef(null);
  const sessionIdRef = useRef(null);
  const sessionReadyResolversRef = useRef([]); // pending connect() promises
  const connectGenerationRef = useRef(0); // guards against a stale connect() finishing after a newer one started

  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const workletNodeRef = useRef(null);
  const scriptProcessorRef = useRef(null);
  const analyserRef = useRef(null);
  const duckGainNodeRef = useRef(null);
  const rafIdRef = useRef(null);

  const micModeRef = useRef("off");
  const pttHeldRef = useRef(false);
  const mutedRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const shouldSendAudioRef = useRef(false); // the ONE gate that decides if a captured frame is sent
  const isAgentSpeakingRef = useRef(false);

  const currentAudioElRef = useRef(null);
  const pingIntervalRef = useRef(null);

  // ---- Low-level send helpers ---------------------------------------------

  const sendJson = useCallback((payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const sendAudioFrame = useCallback((int16Array) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(int16Array.buffer);
    }
  }, []);

  // ---- Playback (agent_audio) + barge-in -----------------------------------

  /**
   * Stops whatever agent audio is currently playing.
   * @param {boolean} ackPlaybackEnded - send {"type":"playback_ended"}; set to
   *   false only when the ack was already/will-be sent by the natural
   *   'ended' handler.
   */
  const stopPlayback = useCallback(
    (ackPlaybackEnded) => {
      const audioEl = currentAudioElRef.current;
      if (audioEl) {
        // Detach handlers first so pausing doesn't trigger a duplicate ack.
        audioEl.onplay = null;
        audioEl.onended = null;
        audioEl.onerror = null;
        audioEl.onpause = null;
        try {
          audioEl.pause();
          audioEl.currentTime = 0;
        } catch (_) {
          /* ignore */
        }
        currentAudioElRef.current = null;
      }
      isAgentSpeakingRef.current = false;
      setIsAgentSpeaking(false);
      if (duckWhileAgentSpeaking && duckGainNodeRef.current) {
        duckGainNodeRef.current.gain.setTargetAtTime(1, audioContextRef.current.currentTime, 0.05);
      }
      if (ackPlaybackEnded) {
        sendJson({ type: "playback_ended" });
      }
    },
    [sendJson, duckWhileAgentSpeaking]
  );

  const playAgentAudio = useCallback(
    (format, audioBase64) => {
      // Defensive: the backend only ever sends one agent_audio per turn, but
      // make sure we never have two clips racing on the page.
      if (currentAudioElRef.current) {
        stopPlayback(true);
      }

      const audioEl = new Audio(`data:audio/${format || "mp3"};base64,${audioBase64}`);
      currentAudioElRef.current = audioEl;

      audioEl.onplay = () => {
        isAgentSpeakingRef.current = true;
        setIsAgentSpeaking(true);
        // IMPORTANT: we do NOT gate/mute the mic here. Audio frames keep
        // flowing to the backend so it can detect the user barging in.
        // Native echo cancellation (see getUserMedia constraints below) is
        // what keeps this playback out of the recognized transcript.
        sendJson({ type: "playback_started" });
        if (duckWhileAgentSpeaking && duckGainNodeRef.current) {
          duckGainNodeRef.current.gain.setTargetAtTime(
            duckGain,
            audioContextRef.current.currentTime,
            0.05
          );
        }
      };
      audioEl.onended = () => {
        isAgentSpeakingRef.current = false;
        setIsAgentSpeaking(false);
        currentAudioElRef.current = null;
        if (duckWhileAgentSpeaking && duckGainNodeRef.current) {
          duckGainNodeRef.current.gain.setTargetAtTime(1, audioContextRef.current.currentTime, 0.05);
        }
        sendJson({ type: "playback_ended" });
      };
      audioEl.onerror = () => {
        isAgentSpeakingRef.current = false;
        setIsAgentSpeaking(false);
        currentAudioElRef.current = null;
        sendJson({ type: "playback_ended" });
      };

      audioEl.play().catch((err) => {
        // Most commonly a browser autoplay-policy block because playback was
        // never tied to a user gesture. Surface it so the UI can prompt the
        // user to tap/click once to "unlock" audio.
        setErrorMessage(
          "Unable to play agent audio automatically (" +
            (err && err.message ? err.message : "autoplay blocked") +
            "). Interact with the page (e.g. tap the mic) once to enable audio playback."
        );
      });
    },
    [sendJson, stopPlayback, duckWhileAgentSpeaking, duckGain]
  );

  // ---- Inbound WebSocket message handling ----------------------------------

  const handleSocketMessage = useCallback(
    (event) => {
      // The backend/BFF protocol only ever sends JSON text frames to the
      // client (binary is client -> server only), so we don't special-case
      // ArrayBuffer here.
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      switch (msg.type) {
        case "session_ready": {
          setConnectionStatus("connected");
          setErrorMessage(null);
          sessionReadyResolversRef.current.forEach((resolve) => resolve());
          sessionReadyResolversRef.current = [];
          break;
        }
        case "status": {
          setSessionStatus(msg.text);
          if (msg.text === "interrupted") {
            // Server-side barge-in: the user started talking again while the
            // agent was thinking/synthesizing/speaking. Stop local playback
            // immediately so the UI doesn't keep "talking" over the user.
            stopPlayback(false); // backend already knows the turn was cancelled
          }
          break;
        }
        case "user_text": {
          setUserTranscript(msg.text || "");
          break;
        }
        case "agent_text": {
          setAgentText(msg.text || "");
          setLastResponseId(msg.response_id || null);
          break;
        }
        case "agent_audio": {
          playAgentAudio(msg.format, msg.audio_base64);
          break;
        }
        case "consent": {
          setConsent({ link: msg.link, text: msg.text });
          break;
        }
        case "error": {
          setErrorMessage(msg.message || "Voice chat error");
          break;
        }
        case "auth_error": {
          setErrorMessage(msg.message || "Voice chat authentication failed");
          setConnectionStatus("error");
          break;
        }
        case "pong": {
          // Reserved for latency tracking if you want to surface connection
          // quality in the UI later.
          break;
        }
        default:
          break;
      }
    },
    [playAgentAudio, stopPlayback]
  );

  // ---- Connection lifecycle ------------------------------------------------

  const clearPing = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const startPing = useCallback(() => {
    clearPing();
    pingIntervalRef.current = setInterval(() => sendJson({ type: "ping" }), PING_INTERVAL_MS);
  }, [clearPing, sendJson]);

  /**
   * Fetches the required auth nonce, opens the WebSocket (idempotent) and
   * resolves once {"type":"session_ready"} has been received, or rejects on
   * timeout/error. This is now async (it was synchronous before) because the
   * nonce fetch must complete BEFORE the socket is opened — see the "WHY THE
   * NONCE" note at the top of this file for why this step was missing before
   * and caused connections to silently never establish.
   */
  const connect = useCallback(async () => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }

    const myGeneration = ++connectGenerationRef.current;
    setConnectionStatus("connecting");
    setErrorMessage(null);
    sessionIdRef.current = safeUuid();

    let resolvedUrl;
    try {
      resolvedUrl = forcedWsUrl || (await buildVoiceWsUrl());
    } catch (err) {
      if (myGeneration !== connectGenerationRef.current) return; // superseded by a newer connect()
      setConnectionStatus("error");
      setErrorMessage("Could not prepare voice connection: " + (err && err.message ? err.message : err));
      throw err;
    }

    // A newer connect() call (or a disconnect()) happened while we were
    // awaiting the nonce fetch — abandon this attempt rather than opening a
    // socket nobody asked for anymore.
    if (myGeneration !== connectGenerationRef.current) return;

    console.debug("[useVoiceChat] connecting to", resolvedUrl);
    const ws = new WebSocket(resolvedUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const readyPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = sessionReadyResolversRef.current.indexOf(resolve);
        if (idx >= 0) sessionReadyResolversRef.current.splice(idx, 1);
        reject(new Error("Timed out waiting for voice session to become ready"));
      }, SESSION_READY_TIMEOUT_MS);

      sessionReadyResolversRef.current.push(() => {
        clearTimeout(timeoutId);
        resolve();
      });
    });

    ws.onopen = () => {
      console.debug("[useVoiceChat] websocket open", resolvedUrl);
      // REQUIRED first frame — see voice_bff.py's _receive_init_session_id.
      ws.send(JSON.stringify({ type: "init", session_id: sessionIdRef.current }));
      startPing();
    };
    ws.onmessage = handleSocketMessage;
    ws.onerror = (ev) => {
      console.error("[useVoiceChat] websocket error", ev);
      setConnectionStatus("error");
    };
    ws.onclose = (ev) => {
      console.debug("[useVoiceChat] websocket closed", ev.code, ev.reason);
      setConnectionStatus("disconnected");
      clearPing();
      wsRef.current = null;
    };

    return readyPromise;
  }, [forcedWsUrl, handleSocketMessage, startPing, clearPing]);

  const disconnect = useCallback(() => {
    connectGenerationRef.current++; // invalidate any in-flight connect()
    if (sessionActiveRef.current) {
      sendJson({ type: "stop_listening" });
    }
    clearPing();
    stopPlayback(false);
    const ws = wsRef.current;
    if (ws) {
      try {
        ws.close(1000, "client disconnect");
      } catch (_) {
        /* ignore */
      }
    }
    wsRef.current = null;
    setConnectionStatus("disconnected");
  }, [sendJson, clearPing, stopPlayback]);

  // ---- Mic capture: getUserMedia -> AudioWorklet -> PCM16 frames -----------

  const startLevelMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buffer = new Float32Array(analyser.fftSize);

    const tick = () => {
      analyser.getFloatTimeDomainData(buffer);
      setAudioLevel(Math.min(1, rmsLevel(buffer) * 4)); // scaled for a nicer meter range
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  const stopLevelMeter = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  /** Called for every captured Float32 audio chunk, regardless of capture path. */
  const handleCapturedChunk = useCallback((float32Chunk, inputSampleRate) => {
    if (!shouldSendAudioRef.current) return; // muted / PTT not held / session inactive
    const resampled = resampleTo16k(float32Chunk, inputSampleRate);
    const pcm16 = floatTo16BitPCM(resampled);
    sendAudioFrame(pcm16);
  }, [sendAudioFrame]);

  const startCapture = useCallback(async () => {
    if (mediaStreamRef.current) return; // already capturing

    // NATIVE echo cancellation lives here: asking for these constraints tells
    // the OS/browser audio stack to run its own AEC/NS/AGC on the captured
    // track, using whatever the page is currently playing out loud (our
    // agent_audio <audio> element) as the reference signal to cancel.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE, // hint only; browsers may ignore it
      },
      video: false,
    });
    mediaStreamRef.current = stream;

    const AudioContextCls = window.AudioContext || window.webkitAudioContext;
    let audioContext;
    try {
      audioContext = new AudioContextCls({ sampleRate: TARGET_SAMPLE_RATE });
    } catch (_) {
      audioContext = new AudioContextCls(); // fall back to device default rate
    }
    audioContextRef.current = audioContext;

    const sourceNode = audioContext.createMediaStreamSource(stream);
    sourceNodeRef.current = sourceNode;

    // Optional extra safety net: a gain node we duck while the agent is
    // speaking (see `duckWhileAgentSpeaking` option). Sits inline before the
    // capture node so it affects what gets sent to the backend.
    const duckGainNode = audioContext.createGain();
    duckGainNode.gain.value = 1;
    duckGainNodeRef.current = duckGainNode;
    sourceNode.connect(duckGainNode);

    // Level meter tap (does not affect the signal that gets sent).
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyserRef.current = analyser;
    duckGainNode.connect(analyser);
    startLevelMeter();

    if (audioContext.audioWorklet) {
      // Preferred path: runs off the main thread, low latency, no deprecation
      // warnings.
      const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      try {
        await audioContext.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      const workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
      workletNode.port.onmessage = (event) => {
        handleCapturedChunk(event.data, audioContext.sampleRate);
      };
      duckGainNode.connect(workletNode);
      // NOTE: workletNode is deliberately NOT connected to audioContext.destination
      // — we never want to loop the raw mic signal back out to the speakers.
      workletNodeRef.current = workletNode;
    } else {
      // Fallback for browsers without AudioWorklet support.
      const bufferSize = 4096;
      const scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
      scriptNode.onaudioprocess = (e) => {
        handleCapturedChunk(e.inputBuffer.getChannelData(0).slice(0), audioContext.sampleRate);
      };
      duckGainNode.connect(scriptNode);
      // ScriptProcessorNode only fires onaudioprocess while connected to a
      // destination in most browsers; route through a silent gain so nothing
      // audible is monitored back to the speakers.
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      scriptNode.connect(silentGain);
      silentGain.connect(audioContext.destination);
      scriptProcessorRef.current = scriptNode;
    }
  }, [handleCapturedChunk, startLevelMeter]);

  const stopCapture = useCallback(() => {
    stopLevelMeter();

    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.onaudioprocess = null;
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    if (duckGainNodeRef.current) {
      duckGainNodeRef.current.disconnect();
      duckGainNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }, [stopLevelMeter]);

  /** Recomputes the single "should this captured frame be sent" gate. */
  const recomputeSendGate = useCallback(() => {
    if (!sessionActiveRef.current || mutedRef.current) {
      shouldSendAudioRef.current = false;
      return;
    }
    if (micModeRef.current === "push-to-talk") {
      shouldSendAudioRef.current = pttHeldRef.current;
    } else if (micModeRef.current === "continuous") {
      // Deliberately independent of isAgentSpeaking — see module docs (B).
      shouldSendAudioRef.current = true;
    } else {
      shouldSendAudioRef.current = false;
    }
  }, []);

  // ---- Public: continuous mic on/off ---------------------------------------

  const enableContinuousMic = useCallback(async () => {
    if (micModeRef.current !== "off") return; // already on (either mode)
    try {
      await connect();
      await startCapture();
      sendJson({ type: "start_listening" });
      micModeRef.current = "continuous";
      sessionActiveRef.current = true;
      setMicMode("continuous");
      setIsMicSessionActive(true);
      recomputeSendGate();
    } catch (err) {
      setErrorMessage("Could not start the microphone: " + (err && err.message ? err.message : err));
      stopCapture();
    }
  }, [connect, startCapture, stopCapture, sendJson, recomputeSendGate]);

  const disableMic = useCallback(() => {
    if (micModeRef.current === "off") return;
    sendJson({ type: "stop_listening" });
    micModeRef.current = "off";
    sessionActiveRef.current = false;
    pttHeldRef.current = false;
    shouldSendAudioRef.current = false;
    setMicMode("off");
    setIsMicSessionActive(false);
    setIsPTTHeld(false);
    stopCapture();
  }, [sendJson, stopCapture]);

  // ---- Public: push-to-talk -------------------------------------------------
  // Backend session is armed once (on first press) and stays armed for as
  // long as the user keeps pressing/releasing — only local frame forwarding
  // is gated per-press, avoiding a slow recognizer restart on every tap.

  const onPTTDown = useCallback(async () => {
    if (micModeRef.current === "off") {
      try {
        await connect();
        await startCapture();
        sendJson({ type: "start_listening" });
        micModeRef.current = "push-to-talk";
        sessionActiveRef.current = true;
        setMicMode("push-to-talk");
        setIsMicSessionActive(true);
      } catch (err) {
        setErrorMessage("Could not start the microphone: " + (err && err.message ? err.message : err));
        stopCapture();
        return;
      }
    } else if (micModeRef.current !== "push-to-talk") {
      // Already active in continuous mode — ignore a push-to-talk press
      // rather than fighting over mode. Callers should disableMic() first if
      // they want to switch modes.
      return;
    }
    pttHeldRef.current = true;
    setIsPTTHeld(true);
    recomputeSendGate();
  }, [connect, startCapture, stopCapture, sendJson, recomputeSendGate]);

  const onPTTUp = useCallback(() => {
    if (micModeRef.current !== "push-to-talk") return;
    pttHeldRef.current = false;
    setIsPTTHeld(false);
    recomputeSendGate(); // stops forwarding frames; backend session stays armed
  }, [recomputeSendGate]);

  // ---- Public: mute (independent of mic mode) -------------------------------

  const setMuted = useCallback(
    (muted) => {
      mutedRef.current = !!muted;
      setIsMuted(!!muted);
      recomputeSendGate();
    },
    [recomputeSendGate]
  );

  const toggleMute = useCallback(() => setMuted(!mutedRef.current), [setMuted]);

  // ---- Misc UI helpers -------------------------------------------------------

  const clearConsent = useCallback(() => setConsent(null), []);
  const clearError = useCallback(() => setErrorMessage(null), []);

  // ---- Lifecycle -------------------------------------------------------------

  useEffect(() => {
    if (autoConnect) {
      connect().catch((err) => setErrorMessage(err.message));
    }
    return () => {
      disableMic();
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    // connection
    connectionStatus, // "disconnected" | "connecting" | "connected" | "error"
    connect,
    disconnect,

    // mic controls
    micMode, // "off" | "continuous" | "push-to-talk"
    isMicSessionActive,
    isPTTHeld,
    isMuted,
    enableContinuousMic,
    disableMic,
    onPTTDown,
    onPTTUp,
    setMuted,
    toggleMute,

    // turn / session state
    sessionStatus, // "idle" | "listening" | "thinking" | "synthesizing" | "ready" | "interrupted"
    isAgentSpeaking,
    userTranscript,
    agentText,
    lastResponseId,
    audioLevel, // 0..1 mic input level, for a level meter if your design has one

    // consent (OAuth Identity Passthrough) + error surfaces
    consent, // { link, text } | null
    clearConsent,
    errorMessage,
    clearError,
  };
}

export default useVoiceChat;
