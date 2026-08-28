import { useState, useEffect, useRef, useCallback } from 'react';

const useTextAgent = (onAgentMessage, setLoading) => {
  const [messages, setMessages] = useState([]);
  const [currentDelta, setCurrentDelta] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [sessionId, setSessionId] = useState(null);
  const [isTextActive, setTextActive] = useState(false)
  const wsRef = useRef(null);
  const callbackRef = useRef(onAgentMessage);
  const connectedRef = useRef(false);
  const currentDeltaRef = useRef('');

  useEffect(() => {
    callbackRef.current = onAgentMessage;
  }, [onAgentMessage]);

  // const loginUser = async () => {
  //   try {
  //     await fetch('/auth/login', {
  //       method: 'POST',
  //       headers: {
  //         'Content-Type': 'application/json',
  //       },
  //       credentials: 'include', // Ensures authentication cookies are saved
  //       body: JSON.stringify({
  //         email: 'user@example.com',
  //         password: 'yourpassword123',
  //       }),
  //     });
  //   } catch (err) {
  //     console.error('Auto-login failed:', err);
  //   }
  // };
  const connect = useCallback(async () => {
    setStatus('connecting');
    // await loginUser();

    // Determine WS protocol (ws:// or wss://)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${protocol}//${window.location.host}/ws/text`;

    // 1. Fetch short-lived single-use authentication nonce
    // try {
    //   // const nonceRes = await fetch('http://127.0.0.1:5500/api/ws-nonce', { credentials: 'include' });
    //   const nonceRes = await fetch('/api/ws-nonce', {
    //     headers: {
    //       'Content-Type': 'application/json',
    //     },
    //   });
    //   console.log("nonceRes is --===>",nonceRes)
    //   if (nonceRes.ok) {
    //     const { nonce } = await nonceRes.json();
    //     console.log("nonce is ===>",nonce)
    //     wsUrl += `?nonce=${encodeURIComponent(nonce)}`;
    //   }
    //   console.log("ws url is -====>",wsUrl)
    // } catch (err) {
    //   console.warn('Failed to fetch WS nonce, trying direct connection:', err);
    // }

    // Don't reconnect if already connected
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // 2. Connect to WebSocket
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      setTextActive(true)
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'session_id':
            setSessionId(data.id);
            break;

          case 'status':
            setStatus(data.text);
            break;

          case 'agent_text_delta': {
            const nextDelta = currentDeltaRef.current + (data.delta || '');
            currentDeltaRef.current = nextDelta;
            setCurrentDelta(nextDelta);

            if (typeof callbackRef.current === 'function') {
              callbackRef.current(data.delta || '', 'ai', { streaming: true });
            }
            setLoading?.(false);
            break;
            
          }

          case 'agent_text': {
            const agentText = (data.text || currentDeltaRef.current || '').trim();
            currentDeltaRef.current = '';
            setCurrentDelta('');

            if (typeof callbackRef.current === 'function') {
              callbackRef.current(agentText, 'ai', { streaming: false });
            }
            setLoading?.(false);
            break;
          }

          case 'error':
            const errorMsg = data.text || '';
            console.error('Agent Error:', errorMsg);
            if (errorMsg.includes('Conversation already has an active response')) {
              // A response is already actively generating, so keep the loader running
              setLoading?.(true);
            } else {
              // For all other errors, reset the buffer and stop the loader
              currentDeltaRef.current = '';
              setCurrentDelta('');
              setLoading?.(false);
            }
            break;

          default:
            break;
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      setTextActive(false)
      currentDeltaRef.current = '';
      setCurrentDelta('');
      setLoading?.(false);
    };

    ws.onerror = (err) => {
      console.error('WebSocket Error:', err);
      setStatus('disconnected');
      currentDeltaRef.current = '';
      setCurrentDelta('');
      setLoading?.(false);
    };
  }, [setLoading]);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'stop' }));
        }
        wsRef.current.close();
      }
    };
  }, []);

  const sendMessage = async (text) => {
    if (!text.trim()) {
      return;
    }

    currentDeltaRef.current = '';
    setCurrentDelta('');
    setLoading?.(true);

    if (!connectedRef.current) {
      connectedRef.current = true;
      await connect();
    }

    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      const maxAttempts = 50;
      let attempts = 0;
      while (wsRef.current?.readyState !== WebSocket.OPEN && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 100));
        attempts += 1;
      }
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not connected');
      setLoading?.(false);
      return;
    }

    setMessages((prev) => [...prev, { id: Date.now(), role: 'user', text }]);

    wsRef.current.send(
      JSON.stringify({
        type: 'user_text',
        text,
      })
    );
  };

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