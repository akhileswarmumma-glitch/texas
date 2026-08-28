import { useState, useRef, useCallback } from 'react';

const useTextAgent = (onAgentMessage, setLoading ,sessionId) => {
  const [messages, setMessages] = useState([]);
  const [currentDelta, setCurrentDelta] = useState('');
  const [status, setStatus] = useState('disconnected');
//   const [sessionId, setSessionId] = useState(null);
  const [isTextActive, setTextActive] = useState(false);

  // Use refs to track values inside async stream loops without staleness
  const callbackRef = useRef(onAgentMessage);
  const currentDeltaRef = useRef('');
  const abortControllerRef = useRef(null);

  // Keep callback fresh across renders
  callbackRef.current = onAgentMessage;

  /**
   * Main function to post message and handle HTTP response streaming
   */
  const sendMessage = async (text) => {
    if (!text.trim()) return;

    // 1. Reset state for new interaction
    currentDeltaRef.current = '';
    setCurrentDelta('');
    setLoading?.(true);
    setStatus('connecting');
    setTextActive(true);

    // Record user message
    setMessages((prev) => [...prev, { id: Date.now(), role: 'user', text }]);

    // Abort any ongoing request before starting a new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      // 2. Fetch stream endpoint via HTTP POST
      const response = await fetch('http://127.0.0.1:8000/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_query: text,
          conversation_id: sessionId, // Pass current sessionId/conversationId if available
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
      }

      setStatus('connected');

      // 3. Consume ReadableStream
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split SSE chunks separated by standard double newlines
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ''; // Preserve incomplete chunk buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const rawData = trimmed.replace(/^data:\s*/, '');
          console.log('[SSE Chunk Received]:', rawData);

          // Check for completion signal sent by your FastAPI endpoint
          if (rawData === '[DONE]') {
            console.log('[SSE Stream Closed by Server]');
            const finalAgentText = currentDeltaRef.current.trim();
            currentDeltaRef.current = '';
            setCurrentDelta('');

            // Send final message payload
            if (typeof callbackRef.current === 'function') {
              callbackRef.current(finalAgentText, 'ai', { streaming: false });
            }
            setLoading?.(false);
            setStatus('disconnected');
            setTextActive(false);
            return;
          }

          // Check for backend error payload
          if (rawData.startsWith('{"error":')) {
            const errorObj = JSON.parse(rawData);
            throw new Error(errorObj.error || 'Server streaming error');
          }

          // 4. Handle incoming text delta
          const deltaChunk = rawData;
          const nextDelta = currentDeltaRef.current + deltaChunk;
          currentDeltaRef.current = nextDelta;
          setCurrentDelta(nextDelta);

          if (typeof callbackRef.current === 'function') {
            callbackRef.current(deltaChunk, 'ai', { streaming: true });
          }
          setLoading?.(false);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Stream request aborted');
        return;
      }

      console.error('Text Agent HTTP Stream Error:', err);
      currentDeltaRef.current = '';
      setCurrentDelta('');
      setStatus('disconnected');
      setTextActive(false);
      setLoading?.(false);
    }
  };

  /**
   * Mock / Reconnect placeholder to maintain backwards API compatibility
   */
  const connect = useCallback(async () => {
    setStatus('disconnected');
    setTextActive(false);
  }, []);

  return {
    messages,
    currentDelta,
    sendMessage,
    status,
    sessionId,
    isTextActive,
    setTextActive,
    reconnect: connect,
  };
};

export default useTextAgent;