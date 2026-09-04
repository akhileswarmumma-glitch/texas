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

  const startVoiceSession = useCallback(async () => {
    if (isVoiceActive) {
      stopVoiceSession();
      return;
    }

    try {
      setStatus('connecting');
      setLoading?.(true);

      // Initialize Audio Playback
      const playback = new AudioPlayback();
      await playback.init();
      audioPlaybackRef.current = playback;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let wsUrl = `${protocol}//${window.location.host}/ws/voice`;

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
        setStatus('connected');
        setIsVoiceActive(true);

        // Start Mic Capture once socket is open
        const capture = new AudioCapture(
          (base64Chunk) => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(
                JSON.stringify({
                  type: 'audio_chunk',
                  data: base64Chunk,
                })
              );
            }
          },
          (level) => setMicLevel(level)
        );

        await capture.start();
        audioCaptureRef.current = capture;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

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

      ws.onclose = () => {
        stopVoiceSession();
      };

      ws.onerror = (err) => {
        console.error('Voice WebSocket Error:', err);
        stopVoiceSession();
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