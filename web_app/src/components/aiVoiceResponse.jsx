import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioCapture } from './audioCapture';
import { AudioPlayback } from './audioPlayback';

const useVoiceAgent = (onAgentMessage, setLoading, options = {}) => {
  const [status, setStatus] = useState('disconnected');
  const [sessionId, setSessionId] = useState(null);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [speakingPaused, setSpeakingPaused] = useState(false);

  const wsRef = useRef(null);
  const audioCaptureRef = useRef(null);
  const audioPlaybackRef = useRef(null);
  const callbackRef = useRef(onAgentMessage);
  const statusRef = useRef('disconnected');
  const agentSpeakingRef = useRef(false);
  const captureEnabledRef = useRef(false); // Controls Push-To-Talk / Mute state

  useEffect(() => {
    callbackRef.current = onAgentMessage;
  }, [onAgentMessage]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const interruptPlayback = useCallback(() => {
    audioPlaybackRef.current?.flush();
    options.onInterrupt?.();
    options.onBargeIn?.();
    agentSpeakingRef.current = false;
    setSpeakingPaused(false);
    setStatus('listening');

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'playback_ended' }));
    }
  }, [options]);

  const stopVoiceSession = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }

    audioCaptureRef.current?.stop();
    audioCaptureRef.current = null;
    captureEnabledRef.current = false;

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

  // --- Push-to-Talk / Unmute ---
  const startCapture = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!audioCaptureRef.current) return;

    captureEnabledRef.current = true;
    audioCaptureRef.current.setEnabled(true);

    // Instant local client-side barge-in if agent is speaking when user engages mic
    if (agentSpeakingRef.current) {
      interruptPlayback();
    }

    try {
      wsRef.current.send(JSON.stringify({ type: 'start_listening' }));
    } catch (e) {
      console.warn('start_listening failed', e);
    }

    setStatus('listening');
  }, [interruptPlayback]);

  // --- Release Push-to-Talk / Mute ---
  const stopCapture = useCallback(() => {
    captureEnabledRef.current = false;
    audioCaptureRef.current?.setEnabled(false);

    setTimeout(() => {
      try {
        wsRef.current?.send(JSON.stringify({ type: 'stop_listening' }));
      } catch (e) {
        console.warn('stop_listening failed', e);
      }
    }, 600);

    setStatus((prev) => (prev === 'listening' ? 'connected' : prev));
  }, []);

  const startVoiceSession = useCallback(async () => {
    if (isVoiceActive) {
      stopVoiceSession();
      return;
    }

    try {
      setStatus('connecting');
      captureEnabledRef.current = false;

      const playback = new AudioPlayback((playing) => {
        agentSpeakingRef.current = playing;

        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: playing ? 'playback_started' : 'playback_ended',
            })
          );
        }

        if (!playing && statusRef.current === 'speaking') {
          setStatus(captureEnabledRef.current ? 'listening' : 'connected');
        }
      });

      await playback.init();
      audioPlaybackRef.current = playback;

      const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
      let wsUrl = apiBase
        ? apiBase.replace(/^https?:/, (m) => (m === 'https:' ? 'wss:' : 'ws:')) + '/voice/chat'
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/voice/chat`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        const voiceSessionId = crypto.randomUUID();
        setSessionId(voiceSessionId);
        setStatus('connected');
        setIsVoiceActive(true);

        ws.send(JSON.stringify({ type: 'init', session_id: voiceSessionId }));

        try {
          const capture = new AudioCapture(
            (base64Chunk) => {
              // Only stream audio frames if mic is enabled via Push-To-Talk or Unmute
              if (!captureEnabledRef.current) return;

              if (wsRef.current?.readyState === WebSocket.OPEN) {
                const binary = atob(base64Chunk);
                const audioBytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i += 1) {
                  audioBytes[i] = binary.charCodeAt(i);
                }
                wsRef.current.send(audioBytes.buffer);
              }
            },
            (level) => setMicLevel(level)
          );

          await capture.start();
          audioCaptureRef.current = capture;
          audioCaptureRef.current.setEnabled(false); // Start session muted until user interacts
        } catch (err) {
          console.error('VoiceAgent: failed to initialize mic on connect', err);
        }
      };

      ws.onmessage = (event) => {
        try {
          let data = null;
          try { data = JSON.parse(event.data); } catch (e) { return; }
          if (!data) return;

          switch (data.type) {
            case 'session_id':
            case 'session_ready':
              if (data.id || data.session_id) setSessionId(data.id || data.session_id);
              setStatus('connected');
              break;

            case 'status':
              if (data.text === 'interrupted' || data.text === 'barge_in') {
                interruptPlayback();
              } else {
                setStatus(data.text);
              }
              break;

            case 'audio_chunk':
              if (!speakingPaused) setStatus('speaking');
              audioPlaybackRef.current?.enqueue(data.data);
              break;

            case 'agent_audio':
              setLoading?.(false);
              try {
                if (data.audio_base64) {
                  audioPlaybackRef.current?.enqueue(data.audio_base64);
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

            case 'consent':
              setLoading?.(false);
              if (typeof callbackRef.current === 'function') {
                callbackRef.current(data.text || 'Consent required to continue.', 'ai', {
                  streaming: false,
                  link: data.link || '',
                  consentRequired: true,
                });
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

      ws.onclose = () => stopVoiceSession();
      ws.onerror = (err) => console.error('Voice WebSocket Error:', err);
    } catch (err) {
      console.error('Failed to start voice session:', err);
      stopVoiceSession();
    }
  }, [isVoiceActive, setLoading, stopVoiceSession, interruptPlayback, speakingPaused]);

  useEffect(() => {
    return () => stopVoiceSession();
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
  };
};

export default useVoiceAgent;