import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * HTTP/SSE version of useTextAgent, replacing the old WebSocket implementation.
 * Talks to the BFF's POST /chatV1 endpoint, which streams frames of the form:
 *   data: {"type": "meta", "response_id": "...", "conversation_id": "..."}
 *   data: {"type": "delta", "content": "..."}
 *   data: {"type": "consent", "link": "...", "response_id": "...", "agent_response": "..."}
 *   data: {"type": "done", "response_id": "...", "link": "", "agent_response": "...", "ticket_number": ...}
 *   data: {"type": "error", "error": "..."}
 */
const CHAT_ENDPOINT = 'https://txrh-app-roadierangerdev-6279-stosup-phmo.azurewebsites.net/api/chatV1'; // same-origin BFF route; adjust if BFF is on a different host

const useTextAgent = (onAgentMessage, setLoading, handleLogout) => {
  const [messages, setMessages] = useState([]);
  const [currentDelta, setCurrentDelta] = useState('');
  const [status, setStatus] = useState('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'streaming'
  const [sessionId, setSessionId] = useState(null); // holds conversation_id, kept for API-shape parity with old hook
  const [isTextActive, setTextActive] = useState(false);

  const callbackRef = useRef(onAgentMessage);
  const currentDeltaRef = useRef('');
  const conversationIdRef = useRef(null);
  const previousResponseIdRef = useRef('');
  const abortControllerRef = useRef(null);

  useEffect(() => {
    callbackRef.current = onAgentMessage;
  }, [onAgentMessage]);

  // Establishes a "session" in the HTTP sense: just mints a conversation_id
  // and flips status, since there's no persistent connection to open.
  const connect = useCallback(async () => {
    setStatus('connecting');

    if (!conversationIdRef.current) {
      conversationIdRef.current =
        (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setSessionId(conversationIdRef.current);
    }

    setStatus('connected');
    setTextActive(true);
  }, []);

  const disconnect = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStatus('disconnected');
    setTextActive(false);
    currentDeltaRef.current = '';
    setCurrentDelta('');
    setLoading?.(false);
  }, [setLoading]);

  useEffect(() => {
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Parses one SSE "data: {...}" line into a frame object, or null if not a data line.
  const parseSseLine = (line) => {
    if (!line.startsWith('data:')) return null;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr) return null;
    try {
      return JSON.parse(jsonStr);
    } catch (err) {
      console.error('Failed to parse SSE frame:', jsonStr, err);
      return null;
    }
  };

  const handleFrame = (frame) => {
    switch (frame.type) {
      case 'meta':
        // Track response_id so the NEXT turn can send it as previous_response_id.
        previousResponseIdRef.current = frame.response_id || '';
        if (frame.conversation_id) {
          conversationIdRef.current = frame.conversation_id;
          setSessionId(frame.conversation_id);
        }
        setStatus('streaming');
        break;

      case 'delta': {
        const nextDelta = currentDeltaRef.current + (frame.content || '');
        currentDeltaRef.current = nextDelta;
        setCurrentDelta(nextDelta);

        if (typeof callbackRef.current === 'function') {
          callbackRef.current(frame.content || '', 'ai', { streaming: true });
        }
        setLoading?.(false);
        break;
      }

      case 'consent': {
        // New frame type your WS code never had to handle.
        currentDeltaRef.current = '';
        setCurrentDelta('');
        if (typeof callbackRef.current === 'function') {
          callbackRef.current(
            frame.agent_response || 'Please provide the consent to access the tools',
            'ai',
            { streaming: false, link: frame.link || '', consentRequired: true }
          );
        }
        previousResponseIdRef.current = frame.response_id || previousResponseIdRef.current;
        setLoading?.(false);
        setStatus('connected');
        break;
      }

      case 'done': {
        const agentText = (frame.agent_response || currentDeltaRef.current || '').trim();
        currentDeltaRef.current = '';
        setCurrentDelta('');

        if (typeof callbackRef.current === 'function') {
          callbackRef.current(agentText, 'ai', {
            streaming: false,
            message_id: frame.response_id,
            ticketNumber: frame.ticket_number ?? null,
            link: frame.link || '',
          });
        }
        previousResponseIdRef.current = frame.response_id || previousResponseIdRef.current;
        setLoading?.(false);
        setStatus('connected');
        break;
      }

      case 'error': {
        const errorMsg = frame.error || 'Something went wrong while contacting the agent.';
        console.error('Agent Error:', errorMsg);
        currentDeltaRef.current = '';
        setCurrentDelta('');

        let userMessage =
          `⚠️ **Something went wrong while contacting the agent.** Please try again later.`;

        // Handle downstream 403 permission error
        if (
          errorMsg.includes('ForbiddenError') ||
          errorMsg.includes('does not have permissions') ||
          errorMsg.includes('"statusCode": 403') ||
          errorMsg.includes('"statusCode":403')
        ) {
          userMessage =
            `⚠️ **We're unable to complete your request because your account doesn't currently have the required access. Please contact your administrator for assistance.**`;
        }
        // Handle downstream 429 Too Many Requests
        else if (
          errorMsg.includes("'innerStatusCode': 429") ||
          errorMsg.includes('"innerStatusCode": 429') ||
          errorMsg.includes('"innerStatusCode":429') ||
          errorMsg.includes('Too Many Requests')
        ) {
          userMessage =
            `⚠️ **The service is currently experiencing high demand. Please try your request again in a few moments.**`;
        }

        if (typeof callbackRef.current === 'function') {
          callbackRef.current(
            userMessage,
            'ai',
            { streaming: false, error: true }
          );
        }
        setLoading?.(false);
        setStatus('connected');
        break;
      }

      default:
        break;
    }
  };

  const sendMessage = async (text) => {
    if (!text.trim()) {
      return;
    }

    currentDeltaRef.current = '';
    setCurrentDelta('');
    setLoading?.(true);

    if (status === 'disconnected') {
      await connect();
    }

    setMessages((prev) => [...prev, { id: Date.now(), role: 'user', text }]);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include', // sends the session cookie to the BFF
        signal: controller.signal,
        body: JSON.stringify({
          user_message: text,
          conversation_id: conversationIdRef.current,
          previous_response_id: previousResponseIdRef.current || '',
        }),
      });
      if (response.status === 401) {
          await handleLogout();
          return;
      }

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Backend error ${response.status}: ${errText}`);
      }

      setStatus('streaming');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line ("\n\n").
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          // An SSE "event" can technically span multiple lines; join non-empty data: lines.
          const lines = rawEvent.split('\n');
          for (const line of lines) {
            const frame = parseSseLine(line.trim());
            if (frame) handleFrame(frame);
          }
        }
      }

      // Flush any trailing partial frame left in the buffer after stream end.
      if (buffer.trim()) {
        const frame = parseSseLine(buffer.trim());
        if (frame) handleFrame(frame);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Chat request aborted');
      } else {
        console.error('Chat request failed:', err);

        currentDeltaRef.current = '';
        setCurrentDelta('');

        const errorMessage = err?.message || '';

        let userMessage =
          `⚠️ **Something went wrong while contacting the agent.** Please try again later.`;

        // Handle downstream 403 permission error
        if (
          errorMessage.includes('ForbiddenError') ||
          errorMessage.includes('does not have permissions') ||
          errorMessage.includes('"statusCode": 403') ||
          errorMessage.includes('"statusCode":403')
        ) {
          userMessage =
            `⚠️ **We’re unable to complete your request because your account doesn’t currently have the required access. Please contact your administrator for assistance.**`;
        }

        // Handle downstream 429 Too Many Requests
        else if (
          errorMessage.includes("'innerStatusCode': 429") ||
          errorMessage.includes('"innerStatusCode": 429') ||
          errorMessage.includes('"innerStatusCode":429') ||
          errorMessage.includes('Too Many Requests')
        ) {
          userMessage =
            `⚠️ **The service is currently experiencing high demand. Please try your request again in a few moments.**`;
        }

        if (typeof callbackRef.current === 'function') {
          callbackRef.current(
            userMessage,
            'ai',
            {
              streaming: false,
              error: true
            }
          );
        }
      }

      setLoading?.(false);
      setStatus('connected');
    } finally {
      abortControllerRef.current = null;
    }
  };

  // Replaces the old WS "stop" message; aborts the in-flight fetch/stream.
  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setLoading?.(false);
    setStatus('connected');
  }, [setLoading]);

  return {
    messages,
    currentDelta,
    sendMessage,
    status,
    sessionId,
    isTextActive,
    setTextActive,
    reconnect: connect,
    stop,
  };
};

export default useTextAgent;