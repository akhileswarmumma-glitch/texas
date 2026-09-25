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
  const voiceActiveRef = useRef(false);
  const audioCaptureRef = useRef(null);
  const audioPlaybackRef = useRef(null);
  const callbackRef = useRef(onAgentMessage);
  const statusRef = useRef('disconnected'); // mirrors `status` state, but always reads the LATEST value inside closures (e.g. the audio_chunk sender in onopen)
  const agentSpeakingRef = useRef(false);

  useEffect(() => {
    callbackRef.current = onAgentMessage;
  }, [onAgentMessage]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);


  const stopVoiceSession = useCallback(async () => {
    voiceActiveRef.current = false;

    const socket = wsRef.current;

    // Detach immediately so this old socket can never interfere
    // with the next voice session.
    if (wsRef.current === socket) {
      wsRef.current = null;
    }

    // Stop microphone first
    try {
      audioCaptureRef.current?.setEnabled(false);
      audioCaptureRef.current?.stop();
    } catch (err) {
      console.warn('Failed to stop audio capture:', err);
    }

    audioCaptureRef.current = null;

    // Stop internal playback
    try {
      audioPlaybackRef.current?.close();
    } catch (err) {
      console.warn('Failed to close audio playback:', err);
    }

    audioPlaybackRef.current = null;

    // IMPORTANT:
    // Wait until THIS socket is actually closed.
    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: 'stop' }));
          } catch (err) {
            console.warn('Failed to send voice stop:', err);
          }
        }

        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          await new Promise((resolve) => {
            let finished = false;

            const finish = () => {
              if (finished) return;
              finished = true;
              resolve();
            };

            socket.addEventListener('close', finish, { once: true });

            try {
              socket.close(1000, 'Voice session ended');
            } catch (err) {
              console.warn('Failed to close websocket:', err);
              finish();
            }

            // Safety fallback only.
            setTimeout(finish, 1500);
          });
        }
      } catch (err) {
        console.warn('Voice websocket cleanup failed:', err);
      }
    }

    agentSpeakingRef.current = false;

    setIsVoiceActive(false);
    setStatus('disconnected');
    setLoading?.(false);
    setSpeakingPaused(false);
  }, [setLoading]);

  const startCapture = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!audioCaptureRef.current) return;   // mic wasn't ready yet (created in onopen)
    try { wsRef.current.send(JSON.stringify({ type: 'start_listening' })); } catch (e) { console.warn('start_listening failed', e); }

    audioCaptureRef.current.setEnabled(true);
    setStatus('listening');
  }, []);


  const stopCapture = useCallback(() => {
    const socket = wsRef.current;
    audioCaptureRef.current?.setEnabled(false);
    setTimeout(() => {
      if (wsRef.current !== socket || socket?.readyState !== WebSocket.OPEN) return;
      try { socket.send(JSON.stringify({ type: 'stop_listening' })); } catch (e) { console.warn('stop_listening failed', e); }
    }, 600);
    setStatus((prev) => (prev === 'listening' ? 'connected' : prev));
  }, [setLoading]);

  const suspendCapture = useCallback(() => {
    audioCaptureRef.current?.setEnabled(false);
  }, []);

  const startVoiceSession = useCallback(async () => {
    if (voiceActiveRef.current) {
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
        // The BFF requires init to be the first frame on every voice connection.
        ws.send(JSON.stringify({ type: 'init', session_id: voiceSessionId }));
        // Do not start mic capture here; push-to-talk will initiate listening when user presses the mic.

        // 🆕 ADD THIS ENTIRE BLOCK — create the mic ONCE per connection
        try {
          let sentChunks = 0;
          const capture = new AudioCapture(
            (base64Chunk) => {
              try {
                // Mic gating: never write frames to the socket while the agent is
                // thinking, synthesizing, OR actually playing audio back (ground
                // truth from the <audio> element, since the backend's status frame
                // never says "speaking" and flips to "ready" before playback ends).
                const gatedStatuses = ['thinking', 'synthesizing'];
                if (gatedStatuses.includes(statusRef.current) || agentSpeakingRef.current) return;


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
            (level) => setMicLevel(level)
          );
          await capture.start();

          // Do not expose the session until its own microphone is ready. This
          // prevents a restart from accepting a mic press while the capture
          // object is still being initialized.
          if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
            capture.stop();
            return;
          }

          audioCaptureRef.current = capture;
          voiceActiveRef.current = true;
          setStatus('connected');
          setIsVoiceActive(true);

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
              setLoading?.(false);
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
                callbackRef.current(data.text || '', 'ai', {
                  streaming: false,
                  message_id: data.response_id || data.id || `voice-${Date.now()}`,
                  link: data.link || '',
                  ticketNumber: data.ticket_number ?? null,
                });
              }
              break;

            case 'consent':
              setLoading?.(false);
              if (typeof callbackRef.current === 'function') {
                callbackRef.current(
                  data.text || 'Please provide the consent to access the tools',
                  'ai',
                  { streaming: false, link: data.link || '', consentRequired: true }
                );
              }
              break;

            case 'notice':
              if (data.code === 'scale_in' && typeof options.onNotice === 'function') {
                options.onNotice(data.message || 'session timeout please create a new chat to continue');
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
        console.debug(
          'VoiceAgent: websocket closed',
          ev.code,
          ev.reason
        );

        // Ignore close events from an OLD voice connection.
        // A new WebSocket may already have been created.
        if (wsRef.current !== ws) {
          console.debug(
            'VoiceAgent: ignoring close from old websocket'
          );
          return;
        }

        wsRef.current = null;
        voiceActiveRef.current = false;

        try {
          audioCaptureRef.current?.setEnabled(false);
          audioCaptureRef.current?.stop();
        } catch (err) {
          console.warn('Failed to clean microphone after websocket close:', err);
        }

        audioCaptureRef.current = null;

        setIsVoiceActive(false);
        setStatus('disconnected');
        setLoading?.(false);
        setSpeakingPaused(false);
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

  return {
    isVoiceActive,
    setIsVoiceActive,
    startVoiceSession,
    stopVoiceSession,
    startCapture,
    stopCapture,
    suspendCapture,
    status,
    sessionId,
    micLevel,
    speakingPaused,
    pauseSpeaking,
    resumeSpeaking,
    notifyPlaybackStarted,
    notifyPlaybackEnded,
    setAgentSpeakingGate,
  };
};

export default useVoiceAgent;