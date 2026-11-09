import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioCapture } from './audioCapture';
import { AudioPlayback } from './audioPlayback';

const createMessageId = () => {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  return `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

// Send the application-level stop before requesting socket closure.
// WebSocket only permits sending while OPEN; a closed/closing socket
// cannot receive another application-level message.
const closeSocketSafely = (socket, reason) => {
  if (!socket) return;

  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: 'stop' }));

      console.log('[Voice WS] Sent stop before closing', {
        reason,
      });
    } catch (err) {
      console.warn('Failed to send voice stop:', err);
    }
  }

  try {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(1000, reason);
    }
  } catch (err) {
    console.warn('Failed to close websocket:', err);
  }
};

const closeRetiringSocket = (socketRef) => {
  const socket = socketRef.current;
  socketRef.current = null;

  closeSocketSafely(socket, 'Voice handoff cleanup');
};

// One automatic reconnect attempt per abnormal drop. Prevents an endless
// loop if the backend is down.
const MAX_FRESH_RECONNECTS = 1;

// Abort the optional nonce request so recovery never hangs on it.
const NONCE_TIMEOUT_MS = 5000;

// A socket stuck in CONNECTING may not fail for a long time.
const CONNECT_TIMEOUT_MS = 10000;

const useVoiceAgent = (
  onAgentMessage,
  setLoading,
  options = {},
  initialSessionId = ''
) => {
  const [status, setStatus] = useState('disconnected');
  const [sessionId, setSessionId] = useState(null);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [speakingPaused, setSpeakingPaused] = useState(false);
  const [progressLabel, setProgressLabel] = useState('');

  const wsRef = useRef(null);
  const retiringSocketRef = useRef(null);
  const voiceActiveRef = useRef(false);

  const audioCaptureRef = useRef(null);
  const audioPlaybackRef = useRef(null);

  const callbackRef = useRef(onAgentMessage);
  const optionsRef = useRef(options);

  // Long-lived callbacks read the latest values from these refs.
  const statusRef = useRef('disconnected');
  const speakingPausedRef = useRef(false);
  const agentSpeakingRef = useRef(false);

  const voiceSessionIdRef = useRef(null);
  const previousResponseIdRef = useRef(null);
  const currentTurnResponseIdRef = useRef(null);
  const pendingUserMessageIdRef = useRef(null);

  const interactionIdRef = useRef(null);
  const cacheHitRef = useRef('miss');

  const reconnectingRef = useRef(false);
  const connectingRef = useRef(false);
  const scaleInPendingRef = useRef(false);

  const voiceTurnInProgressRef = useRef(false);
  const agentProcessingRef = useRef(false);
  const responseReadyRef = useRef(false);
  const turnTextReceivedRef = useRef(false);
  const turnAudioReceivedRef = useRef(false);

  const connectionGenerationRef = useRef(0);
  const startVoiceSessionRef = useRef(null);
  const scaleInGraceTimerRef = useRef(null);

  // Counts automatic reconnects after abnormal closes.
  // Reset when a connection fully succeeds or the user stops voice.
  const reconnectAttemptsRef = useRef(0);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    callbackRef.current = onAgentMessage;
  }, [onAgentMessage]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    speakingPausedRef.current = speakingPaused;
  }, [speakingPaused]);

  useEffect(() => {
    const nextSessionId = String(initialSessionId || '').trim();

    if (
      !nextSessionId ||
      voiceSessionIdRef.current === nextSessionId
    ) {
      return;
    }

    voiceSessionIdRef.current = nextSessionId;
    setSessionId(nextSessionId);
  }, [initialSessionId]);

  const stopVoiceSession = useCallback(async () => {
    // Invalidate connection setup and callbacks still running.
    const stopGeneration = ++connectionGenerationRef.current;

    clearTimeout(scaleInGraceTimerRef.current);
    scaleInGraceTimerRef.current = null;

    // Intentional stop: no automatic reconnect history carries over.
    reconnectAttemptsRef.current = 0;

    connectingRef.current = false;
    reconnectingRef.current = false;
    scaleInPendingRef.current = false;

    voiceTurnInProgressRef.current = false;
    agentProcessingRef.current = false;
    responseReadyRef.current = false;
    turnTextReceivedRef.current = false;
    turnAudioReceivedRef.current = false;

    // Intentional stop clears continuation tracking.
    voiceSessionIdRef.current = null;
    previousResponseIdRef.current = null;
    currentTurnResponseIdRef.current = null;
    pendingUserMessageIdRef.current = null;

    interactionIdRef.current = null;
    cacheHitRef.current = 'miss';

    voiceActiveRef.current = false;
    agentSpeakingRef.current = false;
    speakingPausedRef.current = false;

    const socket = wsRef.current;
    const retiringSocket = retiringSocketRef.current;

    // Detach immediately so old callbacks cannot affect a new session.
    wsRef.current = null;
    retiringSocketRef.current = null;

    if (retiringSocket && retiringSocket !== socket) {
      closeSocketSafely(
        retiringSocket,
        'Voice session ended during handoff'
      );
    }

    try {
      audioCaptureRef.current?.setEnabled(false);
      audioCaptureRef.current?.stop();
    } catch (err) {
      console.warn('Failed to stop audio capture:', err);
    }

    audioCaptureRef.current = null;

    try {
      audioPlaybackRef.current?.close();
    } catch (err) {
      console.warn('Failed to close audio playback:', err);
    }

    audioPlaybackRef.current = null;

    setSessionId(null);
    setIsVoiceActive(false);
    setMicLevel(0);
    setStatus('disconnected');
    setProgressLabel('');
    setLoading?.(false);
    setSpeakingPaused(false);

    if (!socket) return;

    try {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.CLOSING
      ) {
        await new Promise((resolve) => {
          let finished = false;
          let timeoutId;

          const finish = () => {
            if (finished) return;

            finished = true;
            clearTimeout(timeoutId);
            socket.removeEventListener('close', finish);
            resolve();
          };

          socket.addEventListener('close', finish, {
            once: true,
          });

          // Safety fallback only; timeout is not closure confirmation.
          timeoutId = setTimeout(finish, 1500);

          closeSocketSafely(socket, 'Voice session ended');

          if (socket.readyState === WebSocket.CLOSED) {
            finish();
          }
        });
      }
    } catch (err) {
      console.warn('Voice websocket cleanup failed:', err);
    }

    // Do not update a newer session after awaiting the old socket.
    if (stopGeneration !== connectionGenerationRef.current) return;
  }, [setLoading]);

  const startCapture = useCallback(async () => {
    if (
      scaleInPendingRef.current ||
      reconnectingRef.current
    ) {
      return;
    }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!audioCaptureRef.current) return;   // mic wasn't ready yet (created in onopen)
    try { wsRef.current.send(JSON.stringify({ type: 'start_listening' })); } catch (e) { console.warn('start_listening failed', e); }

    audioCaptureRef.current.setEnabled(true);
    setStatus('listening');
  }, []);

  const stopCapture = useCallback(() => {
    const socket = wsRef.current;

    audioCaptureRef.current?.setEnabled(false);

    // Preserve the original stop-listening delay.
    setTimeout(() => {
      if (
        wsRef.current !== socket ||
        socket?.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      try {
        socket.send(JSON.stringify({ type: 'stop_listening' }));
      } catch (err) {
        console.warn('stop_listening failed:', err);
      }
    }, 600);

    setStatus((previous) =>
      previous === 'listening' ? 'connected' : previous
    );
  }, []);

  const suspendCapture = useCallback(() => {
    audioCaptureRef.current?.setEnabled(false);
  }, []);

  const startVoiceSession = useCallback(
    async ({
      resume = false,
      sessionId: requestedSessionId = '',
      auto = false,                   // automatic recovery: no popup
      keepPreviousResponseId = false, // reconnect continues the conversation
    } = {}) => {
      if (connectingRef.current) return;
      if (voiceActiveRef.current && !resume) return;

      connectingRef.current = true;
      const generation = ++connectionGenerationRef.current;

      if (!resume) {
        const nextSessionId = String(
          requestedSessionId ||
          initialSessionId ||
          createMessageId()
        ).trim();

        voiceSessionIdRef.current = nextSessionId || null;

        // Automatic recovery keeps the last completed response ID.
        // A normal new chat clears it.
        if (!keepPreviousResponseId) {
          previousResponseIdRef.current = null;
        }

        interactionIdRef.current = null;
        cacheHitRef.current = 'miss';

        // During automatic recovery, keep blocking push-to-talk until
        // the replacement microphone is ready.
        reconnectingRef.current = Boolean(auto);
      }

      clearTimeout(scaleInGraceTimerRef.current);
      scaleInGraceTimerRef.current = null;

      // A replacement starts without an active local turn.
      // Preserve the last completed response ID when resuming.
      currentTurnResponseIdRef.current = null;
      pendingUserMessageIdRef.current = null;

      scaleInPendingRef.current = false;
      voiceTurnInProgressRef.current = false;
      agentProcessingRef.current = false;
      responseReadyRef.current = false;
      turnTextReceivedRef.current = false;
      turnAudioReceivedRef.current = false;

      setProgressLabel('');

      const voiceSessionId = voiceSessionIdRef.current;

      try {
        setStatus(resume || auto ? 'reconnecting' : 'connecting');

        // Preserve already-received internal playback during recovery.
        if (!resume || !audioPlaybackRef.current) {
          const playback = new AudioPlayback();
          await playback.init();

          if (generation !== connectionGenerationRef.current) {
            playback.close();
            return;
          }

          audioPlaybackRef.current?.close();
          audioPlaybackRef.current = playback;
        }

        const apiBase = (import.meta.env.VITE_API_BASE || '')
          .replace(/\/+$/, '');

        let wsUrl;

        if (apiBase) {
          wsUrl =
            apiBase.replace(/^https?:/, (protocol) =>
              protocol === 'https:' ? 'wss:' : 'ws:'
            ) + '/voice/chat';
        } else {
          const protocol =
            window.location.protocol === 'https:'
              ? 'wss:'
              : 'ws:';

          wsUrl =
            `${protocol}//${window.location.host}/voice/chat`;
        }

        // Preserve optional nonce retrieval, but never let it hang recovery.
        const nonceController = new AbortController();
        const nonceTimer = setTimeout(
          () => nonceController.abort(),
          NONCE_TIMEOUT_MS
        );

        try {
          const nonceResponse = await fetch(
            `${apiBase || ''}/api/ws-nonce`,
            { credentials: 'include', signal: nonceController.signal }
          );

          if (nonceResponse.ok) {
            const { nonce } = await nonceResponse.json();

            if (typeof nonce === 'string' && nonce) {
              wsUrl += `?nonce=${encodeURIComponent(nonce)}`;
            }
          } else {
            console.warn(
              'WS nonce endpoint returned status',
              nonceResponse.status
            );
          }
        } catch (err) {
          console.warn(
            'Failed to fetch WS nonce, proceeding with direct connection:',
            err
          );
        } finally {
          clearTimeout(nonceTimer);
        }

        if (generation !== connectionGenerationRef.current) return;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        // A socket stuck in CONNECTING may not fail for a long time.
        // close() here fires onclose with 1006.
        const connectTimer = setTimeout(() => {
          if (
            wsRef.current === ws &&
            ws.readyState === WebSocket.CONNECTING
          ) {
            console.warn('[Voice WS] Connect timeout', {
              generation,
              resume,
            });
            ws.close();
          }
        }, CONNECT_TIMEOUT_MS);

        const stopCurrentCapture = () => {
          try {
            audioCaptureRef.current?.setEnabled(false);
            audioCaptureRef.current?.stop();
          } catch (err) {
            console.warn('Failed to stop audio capture:', err);
          }

          audioCaptureRef.current = null;
          setMicLevel(0);
        };

        // Remove the user's question from the UI if its answer never arrived.
        // The parent component performs the actual removal through
        // options.onRemoveMessage(messageId).
        const removeUnansweredUserMessage = (reason) => {
          const messageId = pendingUserMessageIdRef.current;

          if (!messageId) {
            console.debug('[Voice WS] No pending user message to remove', {
              reason,
            });
            return;
          }

          // Final answer text reached the UI: the question was answered.
          if (turnTextReceivedRef.current) return;

          const onRemove = optionsRef.current.onRemoveMessage;

          console.warn('[Voice WS] Removing unanswered user message', {
            reason,
            messageId,
            hasHandler: typeof onRemove === 'function',
          });

          if (typeof onRemove === 'function') {
            onRemove(messageId);
          } else {
            console.error(
              '[Voice WS] onRemoveMessage was not passed to useVoiceAgent'
            );
          }

          pendingUserMessageIdRef.current = null;
        };

        const resumeAfterScaleIn = () => {
          if (
            !scaleInPendingRef.current ||
            wsRef.current !== ws
          ) {
            return;
          }

          // Wait for completion, unless onclose discarded the turn.
          if (
            voiceTurnInProgressRef.current ||
            agentProcessingRef.current
          ) {
            return;
          }

          scaleInPendingRef.current = false;
          reconnectingRef.current = true;
          connectingRef.current = false;

          // Invalidate callbacks from the retiring connection.
          connectionGenerationRef.current += 1;

          // Keep the old socket until the replacement opens.
          retiringSocketRef.current = ws;
          voiceActiveRef.current = false;

          setIsVoiceActive(false);
          setStatus('reconnecting');

          stopCurrentCapture();

          // No stop or close here. The replacement onopen does that.
          void startVoiceSessionRef.current?.({ resume: true });
        };

        const captureResponseId = (data) => {
          const responseId = [data.response_id, data.id].find(
            (value) =>
              typeof value === 'string' && value.trim()
          )?.trim();

          if (!responseId) return false;

          currentTurnResponseIdRef.current = responseId;
          return true;
        };

        const completeTurnIfReady = () => {
          if (!voiceTurnInProgressRef.current) return;

          // Wait until final text, audio, and backend readiness have arrived.
          if (
            !turnTextReceivedRef.current ||
            !turnAudioReceivedRef.current ||
            !responseReadyRef.current
          ) {
            return;
          }

          const responseId = currentTurnResponseIdRef.current;

          if (!responseId) {
            console.warn(
              'Voice response finished without response_id; ' +
              'keeping the current socket open.'
            );
            return;
          }

          previousResponseIdRef.current = responseId;
          voiceTurnInProgressRef.current = false;
          agentProcessingRef.current = false;
          pendingUserMessageIdRef.current = null;

          resumeAfterScaleIn();
        };

        const beginTurnIfNeeded = () => {
          // A delayed transcript/response arrived during the scale-in grace
          // period. Keep this socket and drain the turn before reconnecting.
          clearTimeout(scaleInGraceTimerRef.current);
          scaleInGraceTimerRef.current = null;
          agentProcessingRef.current = true;

          if (voiceTurnInProgressRef.current) return;

          currentTurnResponseIdRef.current = null;
          pendingUserMessageIdRef.current = null;
          responseReadyRef.current = false;
          turnTextReceivedRef.current = false;
          turnAudioReceivedRef.current = false;

          voiceTurnInProgressRef.current = true;
        };

        ws.onopen = async () => {
          clearTimeout(connectTimer);

          if (
            generation !== connectionGenerationRef.current ||
            wsRef.current !== ws
          ) {
            closeSocketSafely(ws, 'Stale voice connection');
            return;
          }

          setSessionId(voiceSessionId);

          let capture = null;

          try {
            ws.send(
              JSON.stringify({
                type: 'init',
                ...(voiceSessionId
                  ? { session_id: voiceSessionId }
                  : {}),
                ...((resume || keepPreviousResponseId) &&
                  previousResponseIdRef.current
                  ? {
                      previous_response_id:
                        previousResponseIdRef.current,
                    }
                  : {}),
                interaction_id: interactionIdRef.current,
                cache_hit: cacheHitRef.current,
              })
            );

            console.log('[Voice WS] Socket OPEN; init sent', {
              generation,
              resume,
              auto,
              sessionId: voiceSessionId,
              previousResponseId:
                resume || keepPreviousResponseId
                  ? previousResponseIdRef.current
                  : null,
              readyState: ws.readyState,
            });

            // Replacement is OPEN and init has been sent.
            // Send stop to the old connection, then close it.
            const retiringSocket = retiringSocketRef.current;

            if (retiringSocket && retiringSocket !== ws) {
              retiringSocketRef.current = null;

              closeSocketSafely(
                retiringSocket,
                'Replacement voice websocket opened'
              );
            }

            // Create the microphone once per connection.
            // Push-to-talk controls when capture is enabled.
            let sentChunks = 0;

            capture = new AudioCapture(
              (base64Chunk) => {
                try {
                  // Prevent old or draining capture callbacks
                  // from writing audio to a replacement connection.
                  if (
                    wsRef.current !== ws ||
                    generation !== connectionGenerationRef.current ||
                    scaleInPendingRef.current ||
                    reconnectingRef.current ||
                    ws.readyState !== WebSocket.OPEN
                  ) {
                    return;
                  }

                  // Preserve reference microphone gating.
                  const gatedStatuses = [
                    'thinking',
                    'synthesizing',
                  ];

                  if (
                    gatedStatuses.includes(statusRef.current) ||
                    agentSpeakingRef.current
                  ) {
                    return;
                  }

                  const binary = atob(base64Chunk);
                  const audioBytes = new Uint8Array(binary.length);

                  for (
                    let index = 0;
                    index < binary.length;
                    index += 1
                  ) {
                    audioBytes[index] = binary.charCodeAt(index);
                  }

                  beginTurnIfNeeded();

                  ws.send(audioBytes.buffer);

                  sentChunks += 1;

                  if (sentChunks === 1) {
                    console.debug(
                      'VoiceAgent: sent first audio chunk'
                    );
                  }
                } catch (err) {
                  console.error(
                    'VoiceAgent: failed to send audio chunk',
                    err
                  );
                }
              },
              (level) => {
                if (
                  wsRef.current === ws &&
                  generation === connectionGenerationRef.current &&
                  !scaleInPendingRef.current
                ) {
                  setMicLevel(level);
                }
              }
            );

            await capture.start();

            // Expose the session only when its microphone is ready.
            // reconnectingRef stays true until initialization finishes.
            if (
              generation !== connectionGenerationRef.current ||
              wsRef.current !== ws ||
              ws.readyState !== WebSocket.OPEN ||
              scaleInPendingRef.current
            ) {
              capture.stop();
              return;
            }

            audioCaptureRef.current = capture;
            voiceActiveRef.current = true;
            connectingRef.current = false;
            reconnectingRef.current = false;

            setStatus('connected');
            setIsVoiceActive(true);

            // Connection fully succeeded: the next abnormal drop may
            // reconnect again.
            reconnectAttemptsRef.current = 0;
          } catch (err) {
            console.error(
              'VoiceAgent: failed to initialize connection or microphone',
              err
            );

            try {
              capture?.stop();
            } catch (cleanupError) {
              console.warn(
                'Failed to clean partially initialized microphone:',
                cleanupError
              );
            }

            if (
              generation !== connectionGenerationRef.current ||
              wsRef.current !== ws
            ) {
              return;
            }

            connectingRef.current = false;
            reconnectingRef.current = false;
            voiceActiveRef.current = false;

            setIsVoiceActive(false);
            setLoading?.(false);

            closeRetiringSocket(retiringSocketRef);

            // onclose handles remaining cleanup.
            closeSocketSafely(
              ws,
              'Voice initialization failed'
            );
          }
        };

        ws.onmessage = (event) => {
          if (
            wsRef.current !== ws ||
            generation !== connectionGenerationRef.current
          ) {
            return;
          }

          try {
            let data = null;

            try {
              data = JSON.parse(event.data);
            } catch {
              // Preserve logging for non-JSON frames.
            }

            if (!data) {
              console.debug(
                'VoiceAgent: ws message (raw):',
                event.data
              );
              return;
            }

            console.debug(
              'VoiceAgent: ws message type=',
              data.type
            );

            if (
              Object.prototype.hasOwnProperty.call(
                data,
                'interaction_id'
              )
            ) {
              interactionIdRef.current =
                data.interaction_id ?? null;
            }

            if (
              Object.prototype.hasOwnProperty.call(
                data,
                'cache_hit'
              )
            ) {
              cacheHitRef.current = data.cache_hit ?? 'miss';
            }

            switch (data.type) {
              case 'session_id': {
                if (
                  typeof data.id === 'string' &&
                  data.id.trim()
                ) {
                  voiceSessionIdRef.current = data.id.trim();
                  setSessionId(data.id.trim());
                }

                break;
              }

              case 'status': {
                const statusText = data.text || data.state || '';
                const label =
                  typeof data.label === 'string'
                    ? data.label.trim()
                    : '';

                if (label) {
                  setProgressLabel(label);
                }

                if (
                  statusText === 'thinking' ||
                  statusText === 'synthesizing'
                ) {
                  agentProcessingRef.current = true;
                }

                if (scaleInPendingRef.current && statusText) {
                  // A status after scale-in means this connection is still
                  // reporting the current interaction. Do not let the grace
                  // timer start a replacement while its response is pending.
                  clearTimeout(scaleInGraceTimerRef.current);
                  scaleInGraceTimerRef.current = null;
                }

                if (statusText === 'barge_in') {
                  audioPlaybackRef.current?.flush();
                  setProgressLabel('');
                  setStatus('listening');
                } else {
                  setStatus(statusText);

                  if (
                    statusText === 'ready' &&
                    voiceTurnInProgressRef.current
                  ) {
                    responseReadyRef.current = true;
                    completeTurnIfReady();
                  }
                }

                break;
              }

              case 'audio_chunk': {
                setProgressLabel('');

                if (!speakingPausedRef.current) {
                  setStatus('speaking');
                }

                audioPlaybackRef.current?.enqueue(data.data);

                if (
                  typeof data.data === 'string' &&
                  data.data.length > 0
                ) {
                  turnAudioReceivedRef.current = true;
                }

                completeTurnIfReady();
                break;
              }

              case 'agent_audio': {
                agentProcessingRef.current = true;
                setProgressLabel('');
                setLoading?.(false);

                captureResponseId(data);

                try {
                  const binary = atob(data.audio_base64 || '');
                  const bytes = new Uint8Array(binary.length);

                  for (
                    let index = 0;
                    index < binary.length;
                    index += 1
                  ) {
                    bytes[index] = binary.charCodeAt(index);
                  }

                  const format = data.format || 'audio/mpeg';
                  const blob = new Blob([bytes], {
                    type: format,
                  });

                  if (
                    typeof optionsRef.current.onAudio === 'function'
                  ) {
                    const url = URL.createObjectURL(blob);

                    // Receiving component owns URL cleanup.
                    optionsRef.current.onAudio({
                      url,
                      blob,
                      format,
                    });
                  } else {
                    // Preserve existing internal playback fallback.
                    audioPlaybackRef.current?.enqueue(
                      data.audio_base64
                    );
                  }

                  if (
                    typeof data.audio_base64 === 'string' &&
                    data.audio_base64.length > 0
                  ) {
                    turnAudioReceivedRef.current = true;
                  }

                  // Preserve consent/link message behavior.
                  try {
                    const hasLink = Boolean(data.link);
                    const consentRequired = Boolean(
                      data.consent ||
                      data.consentRequired ||
                      hasLink
                    );

                    if (
                      (hasLink || consentRequired) &&
                      typeof callbackRef.current === 'function'
                    ) {
                      const caption =
                        data.caption ||
                        data.text ||
                        'Voice message contains a link. ' +
                          'Grant consent to open.';

                      callbackRef.current(caption, 'ai', {
                        streaming: false,
                        link: data.link || '',
                        consentRequired,
                      });
                    }
                  } catch (err) {
                    console.warn(
                      'Failed to emit consent message for agent_audio:',
                      err
                    );
                  }
                } catch (err) {
                  console.error(
                    'Failed to handle agent_audio:',
                    err
                  );
                }

                completeTurnIfReady();
                break;
              }

              case 'agent_text_delta': {
                beginTurnIfNeeded();

                setProgressLabel('');
                setLoading?.(false);

                if (typeof callbackRef.current === 'function') {
                  callbackRef.current(data.delta || '', 'ai', {
                    streaming: true,
                  });
                }

                break;
              }

              case 'user_text': {
                beginTurnIfNeeded();
                agentProcessingRef.current = true;
                setProgressLabel('');

                const transcript = [
                  data.text,
                  data.user_text,
                  data.transcript,
                  data.content,
                ].find(
                  (value) =>
                    typeof value === 'string' &&
                    value.trim()
                );

                if (
                  transcript &&
                  typeof callbackRef.current === 'function'
                ) {
                  const messageId =
                    pendingUserMessageIdRef.current ||
                    createMessageId();

                  pendingUserMessageIdRef.current = messageId;

                  callbackRef.current(
                    transcript.trim(),
                    'user',
                    {
                      message_id: messageId,
                    }
                  );

                  setLoading?.(true);
                }

                break;
              }

              case 'agent_text': {
                agentProcessingRef.current = true;
                setProgressLabel('');
                captureResponseId(data);

                if (
                  typeof data.interaction_id === 'string' &&
                  data.interaction_id.trim()
                ) {
                  interactionIdRef.current =
                    data.interaction_id.trim();
                }

                setLoading?.(false);

                if (typeof callbackRef.current === 'function') {
                  callbackRef.current(data.text || '', 'ai', {
                    streaming: false,
                    message_id:
                      data.response_id ||
                      data.id ||
                      createMessageId(),
                    link: data.link || '',
                    ticketNumber: data.ticket_number ?? null,
                  });
                }

                turnTextReceivedRef.current = true;

                completeTurnIfReady();
                break;
              }

              case 'consent': {
                setProgressLabel('');
                captureResponseId(data);
                setLoading?.(false);

                if (typeof callbackRef.current === 'function') {
                  callbackRef.current(
                    data.text ||
                      'Please provide consent to access the tools.',
                    'ai',
                    {
                      streaming: false,
                      link: data.link || '',
                      consentRequired: true,
                    }
                  );
                }

                // Consent counts as final text, not audio.
                turnTextReceivedRef.current = true;

                // CHANGE 5: consent has no audio, so mark audio as
                // received or completeTurnIfReady() never passes.
                turnAudioReceivedRef.current = true;

                completeTurnIfReady();
                break;
              }

              case 'notice': {
                if (data.code !== 'scale_in') break;

                if (scaleInPendingRef.current) break;

                // CHANGE 6: read before setStatus; statusRef updates
                // later via effect.
                const wasListening = statusRef.current === 'listening';

                reconnectingRef.current = true;
                scaleInPendingRef.current = true;

                setStatus('reconnecting');

                // User was mid-utterance: end it so the server still answers.
                if (
                  wasListening &&
                  voiceTurnInProgressRef.current &&
                  ws.readyState === WebSocket.OPEN
                ) {
                  try {
                    ws.send(JSON.stringify({ type: 'stop_listening' }));
                  } catch (err) {
                    console.warn('stop_listening failed:', err);
                  }
                }

                // Stop new microphone input, but keep receiving
                // the current response on this connection.
                stopCurrentCapture();

                if (!voiceTurnInProgressRef.current) {
                  // Give a just-submitted user turn time to arrive on this
                  // connection before starting the replacement socket.
                  clearTimeout(scaleInGraceTimerRef.current);
                  scaleInGraceTimerRef.current = setTimeout(() => {
                    scaleInGraceTimerRef.current = null;

                    if (
                      wsRef.current === ws &&
                      scaleInPendingRef.current &&
                      !voiceTurnInProgressRef.current &&
                      !agentProcessingRef.current
                    ) {
                      resumeAfterScaleIn();
                    }
                  }, 3000);
                }

                // If a turn is active, completeTurnIfReady() performs the
                // handoff only after final text, audio, and ready arrive.

                break;
              }

              case 'error': {
                const wasDraining = scaleInPendingRef.current;

                setProgressLabel('');
                setLoading?.(false);

                console.error('Voice Agent Error:', data.text);

                if (wasDraining) {
                  // Do not close or replace this socket without a complete
                  // agent response and response ID. Keep waiting for delivery.
                } else {
                  currentTurnResponseIdRef.current = null;
                  responseReadyRef.current = false;
                  turnTextReceivedRef.current = false;
                  turnAudioReceivedRef.current = false;
                  voiceTurnInProgressRef.current = false;
                  pendingUserMessageIdRef.current = null;

                  if (typeof callbackRef.current === 'function') {
                    callbackRef.current(
                      `⚠️ ${data.text || 'Something went wrong.'}`,
                      'ai',
                      { streaming: false }
                    );
                  }
                }

                break;
              }

              default:
                break;
            }
          } catch (err) {
            console.error(
              'Failed to handle WS message:',
              err
            );
          }
        };

        ws.onclose = (event) => {
          clearTimeout(connectTimer);

          console.log('[Voice WS] Socket CLOSED', {
            generation,
            readyState: ws.readyState,
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
            scaleInPending: scaleInPendingRef.current,
            voiceTurnInProgress: voiceTurnInProgressRef.current,
            agentProcessing: agentProcessingRef.current,
            receivedAgentText: turnTextReceivedRef.current,
            receivedAgentAudio: turnAudioReceivedRef.current,
            responseId: currentTurnResponseIdRef.current,
          });

          // An old socket must not reset the replacement session.
          if (
            wsRef.current !== ws ||
            generation !== connectionGenerationRef.current
          ) {
            console.debug(
              'VoiceAgent: ignoring close from old websocket'
            );
            return;
          }

          clearTimeout(scaleInGraceTimerRef.current);
          scaleInGraceTimerRef.current = null;

          // Abnormal closure (1006, 1001, 1011, 1012, ...): the server, pod
          // or proxy dropped the connection. Open a new socket with the SAME
          // session_id and continue from the last completed response.
          // This runs before the scale-in branch, so it also covers
          // "scale_in notice, then 1006".
          const isAbnormalClose =
            event.code !== 1000 && event.code !== 1008; // 1008 = rejected by policy

          if (
            isAbnormalClose &&
            reconnectAttemptsRef.current < MAX_FRESH_RECONNECTS
          ) {
            reconnectAttemptsRef.current += 1;

            // If the final answer text already reached the UI, keep that
            // turn and continue from its response ID.
            if (
              turnTextReceivedRef.current &&
              currentTurnResponseIdRef.current
            ) {
              previousResponseIdRef.current =
                currentTurnResponseIdRef.current;
            }

            // The question never got its answer. Remove it from the UI.
            removeUnansweredUserMessage('abnormal close');

            const reconnectSessionId =
              voiceSessionIdRef.current || createMessageId();

            console.warn('[Voice WS] Abnormal close, reconnecting', {
              code: event.code,
              sessionId: reconnectSessionId,
              previousResponseId: previousResponseIdRef.current,
            });

            closeRetiringSocket(retiringSocketRef);
            wsRef.current = null;

            voiceActiveRef.current = false;
            connectingRef.current = false; // otherwise startVoiceSession returns early
            reconnectingRef.current = true;
            scaleInPendingRef.current = false;

            voiceTurnInProgressRef.current = false;
            agentProcessingRef.current = false;
            responseReadyRef.current = false;
            turnTextReceivedRef.current = false;
            turnAudioReceivedRef.current = false;
            currentTurnResponseIdRef.current = null;
            pendingUserMessageIdRef.current = null;

            stopCurrentCapture();

            setIsVoiceActive(false);
            setStatus('reconnecting');
            setProgressLabel('');
            setLoading?.(false);

            void startVoiceSessionRef.current?.({
              resume: false,
              sessionId: reconnectSessionId, // same session ID
              auto: true,                    // no popup if it fails
              keepPreviousResponseId: true,  // continue the conversation
            });

            return;
          }

          if (scaleInPendingRef.current) {
            if (voiceTurnInProgressRef.current) {
              const receivedFinalText = turnTextReceivedRef.current;
              const receivedAgentAudio = turnAudioReceivedRef.current;
              const responseId = currentTurnResponseIdRef.current;

              if (!receivedFinalText || !receivedAgentAudio || !responseId) {
                // The old transport is already closed and cannot deliver the
                // rest of the response. Preserve the transcript/session and
                // recover instead of leaving voice disconnected.
                console.warn(
                  'Scale-in socket closed before the agent response completed; ' +
                  'resuming from the last completed response.'
                );

                // If text arrived, use its response ID as the continuation
                // point even though its audio was cut off by the closed socket.
                if (receivedFinalText && responseId) {
                  previousResponseIdRef.current = responseId;
                }

                // Remove the unanswered question and stop the spinner.
                removeUnansweredUserMessage('scale-in close');
                setLoading?.(false);
              } else {
                // Preserve the completed response ID when it was received.
                previousResponseIdRef.current = responseId;
                pendingUserMessageIdRef.current = null;
              }
            }

            // While OPEN, handoff waits for completeTurnIfReady(). This path
            // only runs after the old transport has already closed.
            pendingUserMessageIdRef.current = null;
            currentTurnResponseIdRef.current = null;
            voiceTurnInProgressRef.current = false;
            agentProcessingRef.current = false;
            responseReadyRef.current = false;
            turnTextReceivedRef.current = false;
            turnAudioReceivedRef.current = false;
            resumeAfterScaleIn();
            return;
          }

          // Normal close or failed replacement.
          // Reconnect already used, or the server closed with 1000/1008
          // mid-turn: the question will not be answered on this connection.
          removeUnansweredUserMessage('connection closed');

          closeRetiringSocket(retiringSocketRef);
          wsRef.current = null;

          voiceActiveRef.current = false;
          connectingRef.current = false;
          reconnectingRef.current = false;
          scaleInPendingRef.current = false;

          voiceTurnInProgressRef.current = false;
          agentProcessingRef.current = false;
          responseReadyRef.current = false;
          turnTextReceivedRef.current = false;
          turnAudioReceivedRef.current = false;
          currentTurnResponseIdRef.current = null;
          pendingUserMessageIdRef.current = null;

          stopCurrentCapture();

          speakingPausedRef.current = false;

          setIsVoiceActive(false);
          setStatus('disconnected');
          setProgressLabel('');
          setLoading?.(false);
          setSpeakingPaused(false);
        };

        ws.onerror = (err) => {
          console.error('Voice WebSocket Error:', err);

          // onclose handles cleanup and scale-in recovery.
        };
      } catch (err) {
        if (generation !== connectionGenerationRef.current) {
          return;
        }

        console.error('Failed to start voice session:', err);

        closeRetiringSocket(retiringSocketRef);

        connectingRef.current = false;
        reconnectingRef.current = false;
        voiceActiveRef.current = false;

        audioPlaybackRef.current?.close();
        audioPlaybackRef.current = null;

        setIsVoiceActive(false);
        setStatus('disconnected');
        setProgressLabel('');
        setLoading?.(false);

        // No popup for failed automatic recovery.
        if (!resume && !auto) {
          optionsRef.current.onNotice?.(
            'Unable to connect voice chat. Please try again.'
          );
        }
      }
    },
    [initialSessionId, setLoading]
  );

  useEffect(() => {
    startVoiceSessionRef.current = startVoiceSession;
  }, [startVoiceSession]);

  useEffect(() => {
    return () => {
      void stopVoiceSession();
    };
  }, [stopVoiceSession]);

  // CHANGE 8: send stop on tab close or refresh, when React cleanup
  // may not run.
  useEffect(() => {
    const onPageHide = () => {
      closeSocketSafely(wsRef.current, 'Page closed');
      closeSocketSafely(retiringSocketRef.current, 'Page closed');
    };

    window.addEventListener('pagehide', onPageHide);

    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  const pauseSpeaking = useCallback(() => {
    audioPlaybackRef.current?.pause?.();

    speakingPausedRef.current = true;

    setSpeakingPaused(true);
    setStatus('speaking_paused');
  }, []);

  const resumeSpeaking = useCallback(() => {
    audioPlaybackRef.current?.resume?.();

    speakingPausedRef.current = false;

    setSpeakingPaused(false);
    setStatus('speaking');
  }, []);

  const notifyPlaybackStarted = useCallback(() => {
    const socket = wsRef.current;

    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(
          JSON.stringify({ type: 'playback_started' })
        );
      } catch (err) {
        console.warn('playback_started failed:', err);
      }
    }
  }, []);

  const notifyPlaybackEnded = useCallback(() => {
    const socket = wsRef.current;

    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(
          JSON.stringify({ type: 'playback_ended' })
        );
      } catch (err) {
        console.warn('playback_ended failed:', err);
      }
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
    progressLabel,
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