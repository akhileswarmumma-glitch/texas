import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioCapture } from './audioCapture';
import { AudioPlayback } from './audioPlayback';

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

  useEffect(() => {
    callbackRef.current = onAgentMessage;
  }, [onAgentMessage]);

  const stopVoiceSession = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }

    audioCaptureRef.current?.stop();
    audioCaptureRef.current = null;

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

  const startCapture = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (audioCaptureRef.current) return;

    // tell server we're starting to send audio
    try { wsRef.current.send(JSON.stringify({ type: 'start_listening' })); } catch (e) { console.warn('start_listening failed', e); }

    console.log('VoiceAgent: starting capture');
    let sentChunks = 0;
    const capture = new AudioCapture(
      (base64Chunk) => {
        try {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                type: 'audio_chunk',
                data: base64Chunk,
              })
            );
            sentChunks += 1;
            if (sentChunks === 1) console.debug('VoiceAgent: sent first audio chunk');
          }
        } catch (err) {
          console.error('VoiceAgent: failed to send audio chunk', err);
        }
      },
      (level) => setMicLevel(level)
    );

    await capture.start();
    audioCaptureRef.current = capture;
    console.log('VoiceAgent: capture started');
    setStatus('listening');
  }, []);

  const stopCapture = useCallback(() => {
    audioCaptureRef.current?.stop();
    audioCaptureRef.current = null;
    // notify server we finished sending audio
    try { wsRef.current?.send(JSON.stringify({ type: 'stop_listening' })); } catch (e) { console.warn('stop_listening failed', e); }
    setStatus((prev) => (prev === 'listening' ? 'connected' : prev));
  }, []);

  const startVoiceSession = useCallback(async () => {
    if (isVoiceActive) {
      stopVoiceSession();
      return;
    }

    try {
      setStatus('connecting');

      // Initialize Audio Playback
      const playback = new AudioPlayback();
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
        const nonceRes = await fetch('/api/ws-nonce');
        if (nonceRes.ok) {
          const { nonce } = await nonceRes.json();
          wsUrl += `?nonce=${encodeURIComponent(nonce)}`;
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
        // Do not start mic capture here; push-to-talk will initiate listening when user presses the mic.
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
              setSessionId(data.id);
              break;

            case 'status':
              if (data.text === 'barge_in') {
                // Instantly silence speaker output when user interrupts
                audioPlaybackRef.current?.flush();
                setStatus('listening');
              } else {
                setStatus(data.text);
              }
              break;

            case 'audio_chunk':
              if (!speakingPaused) setStatus('speaking');
              audioPlaybackRef.current?.enqueue(data.data);
              break;

            case 'agent_audio':
              // server sent a ready-to-play audio clip (e.g. mp3)
              try {
                const bin = atob(data.audio_base64 || '');
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const blob = new Blob([bytes], { type: data.format || 'audio/mpeg' });
                const url = URL.createObjectURL(blob);
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
              if (typeof callbackRef.current === 'function') {
                callbackRef.current(data.text, 'user');
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

  return {
    isVoiceActive,
    startVoiceSession,
    stopVoiceSession,
    startCapture,
    stopCapture,
    status,
    sessionId,
    micLevel,
    speakingPaused,
    pauseSpeaking,
    resumeSpeaking,
    notifyPlaybackStarted,
    notifyPlaybackEnded,
  };
};

export default useVoiceAgent;