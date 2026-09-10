import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaUser } from "react-icons/fa";
import { FiLogOut, FiPlus, FiSend, FiMic, FiSquare, FiChevronDown, FiMessageSquare, FiPlay, FiPause, FiRotateCcw, FiLink, FiCheckCircle, FiPower } from "react-icons/fi";
import ReactMarkdown from "react-markdown";
import "./markdown.css";
import remarkGfm from "remark-gfm";
import useTextAgent from "./aiTextResponse.jsx";
import useVoiceAgent from "./aiVoiceResponse.jsx";
import WarningPopUp from "./warningPopUp.jsx";
import texasLogo from "../assets/texas-logo.png";
// Add this helper near the top of the file
function themeColor(name, fallback) {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  return value?.trim() || fallback;
}

// function WaveformPlayer({ audioRef, audioBlob, audioDuration, isPlaying, onSeek, onPlayToggle }) {
//   const canvasRef = useRef(null);
//   const drawBarsRef = useRef(null);
//   const valuesRef = useRef(null);
//   const bars = 60;

//   useEffect(() => {
//     let cancelled = false;
//     const canvas = canvasRef.current;
//     if (!canvas) return;
//     const ctx = canvas.getContext("2d");

//     const roundRect = (x, y, w, h, r) => {
//       ctx.beginPath();
//       ctx.moveTo(x + r, y);
//       ctx.arcTo(x + w, y, x + w, y + h, r);
//       ctx.arcTo(x + w, y + h, x, y + h, r);
//       ctx.arcTo(x, y + h, x, y, r);
//       ctx.arcTo(x, y, x + w, y, r);
//       ctx.closePath();
//       ctx.fill();
//     };

//     const drawBars = (values) => {
//       const dpr = window.devicePixelRatio || 1;
//       const cssW = canvas.clientWidth || 320;
//       const cssH = canvas.clientHeight || 40;
//       canvas.width = Math.floor(cssW * dpr);
//       canvas.height = Math.floor(cssH * dpr);
//       const w = canvas.width / dpr;
//       const h = canvas.height / dpr;
//       ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
//       ctx.clearRect(0, 0, w, h);

//       const gap = 3;
//       const barW = Math.max(2, (w - (bars - 1) * gap) / bars);
//       const vals = Array.isArray(values)
//         ? values
//         : new Array(bars).fill(0).map(() => Math.random() * 0.5 + 0.15);

//       const barColor = themeColor("--maroon-primary", "#7a2331");
//       const playedColor = themeColor("--primary-bg", "#f2b807");
//       const progress = audioDuration ? (audioRef.current?.currentTime || 0) / audioDuration : 0;

//       for (let i = 0; i < bars; i++) {
//         const val = vals[i] ?? 0.2;
//         const bh = Math.max(3, val * h);
//         const x = i * (barW + gap);
//         const y = (h - bh) / 2;
//         const played = i / bars <= progress;
//         ctx.fillStyle = played ? playedColor : barColor;
//         ctx.globalAlpha = played ? 1 : 0.55;
//         roundRect(x, y, barW, bh, Math.min(3, barW / 2));
//       }
//       ctx.globalAlpha = 1;
//     };
//     drawBarsRef.current = drawBars;

//     const decodeAndDraw = async (blob) => {
//       try {
//         const arrayBuffer = await blob.arrayBuffer();
//         const ac = new (window.AudioContext || window.webkitAudioContext)();
//         const audioBuffer = await ac.decodeAudioData(arrayBuffer.slice(0));
//         const channel = audioBuffer.getChannelData(0);
//         const values = new Array(bars).fill(0).map((_, i) => {
//           const start = Math.floor((i / bars) * channel.length);
//           const end = Math.floor(((i + 1) / bars) * channel.length);
//           let sum = 0;
//           for (let j = start; j < end; j++) sum += Math.abs(channel[j]);
//           return sum / (end - start) || 0;
//         });
//         if (!cancelled) {
//           valuesRef.current = values.map((v) => Math.min(1, v * 4));
//           drawBarsRef.current?.(valuesRef.current);
//         }
//         ac.close();
//       } catch (err) {
//         if (!cancelled) {
//           valuesRef.current = new Array(bars).fill(0).map(() => Math.random() * 0.5 + 0.15);
//           drawBarsRef.current?.(valuesRef.current);
//         }
//       }
//     };

//     if (audioBlob) decodeAndDraw(audioBlob);
//     else {
//       valuesRef.current = new Array(bars).fill(0).map(() => Math.random() * 0.5 + 0.15);
//       drawBarsRef.current(valuesRef.current);
//     }

//     return () => { cancelled = true; };
//   }, [audioBlob, audioDuration, isPlaying]);

//   useEffect(() => {
//     if (!isPlaying) return undefined;
//     let animationFrame;
//     const redraw = () => {
//       drawBarsRef.current?.(valuesRef.current);
//       animationFrame = requestAnimationFrame(redraw);
//     };
//     animationFrame = requestAnimationFrame(redraw);
//     return () => cancelAnimationFrame(animationFrame);
//   }, [isPlaying]);

//   useEffect(() => {
//     const canvas = canvasRef.current;
//     if (!canvas) return;
//     const handleClick = (ev) => {
//       const rect = canvas.getBoundingClientRect();
//       const rel = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
//       if (typeof onSeek === "function") onSeek(rel * (audioDuration || 0));
//     };
//     canvas.addEventListener("click", handleClick);
//     return () => canvas.removeEventListener("click", handleClick);
//   }, [audioDuration, onSeek]);

//   return (
//     <div
//       className="rounded-xl w-[70%] h-[40px] flex items-center gap-3 p-2.5 border border-[var(--neutral-300)]"
//       style={{ background: "var(--white-100, #fff)" }}
//     >
//       <button
//         type="button"
//         onClick={onPlayToggle}
//         aria-label={isPlaying ? "Pause response" : "Play response"}
//         aria-pressed={isPlaying}
//         className="flex-shrink-0 w-[30px] h-[30px] rounded-full grid place-items-center text-white transition hover:opacity-90"
//         style={{ background: "var(--maroon-primary)" }}
//       >
//         {isPlaying ? (
//           <span className="flex gap-[3px]">
//             <span className="w-[3px] h-3.5 bg-white rounded-sm" />
//             <span className="w-[3px] h-3.5 bg-white rounded-sm" />
//           </span>
//         ) : (
//           <span className="ml-0.5" style={{ fontSize: 14 }}>▶</span>
//         )}
//       </button>
//       <canvas
//         ref={canvasRef}
//         aria-label="Seek within response audio"
//         role="slider"
//         aria-valuemin={0}
//         aria-valuemax={audioDuration || 0}
//         style={{ flex: 1, width: "70%", height: 40, cursor: "pointer" }}
//       />
//     </div>
//   );
// }

function formatDuration(t) {
  if (!t && t !== 0) return "0:00";
  const sec = Math.floor(t || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function CurrentResponsePlayer({ audioCurrentTime, audioDuration, isPlaying, stateLabel, onSeek, onPlayToggle, onReplay }) {
  const barRef = useRef(null);
  const progress = audioDuration ? Math.min(1, audioCurrentTime / audioDuration) : 0;

  const handleBarClick = (ev) => {
    const bar = barRef.current;
    if (!bar || !audioDuration) return;
    const rect = bar.getBoundingClientRect();
    const rel = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    onSeek?.(rel * audioDuration);
  };

  return (
    <div className="rounded-xl border px-4 py-3" style={{ borderColor: "#2a2f3a" }}>
      {/* <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-extrabold tracking-wider" style={{ color: "#9aa2b1" }}>CURRENT RESPONSE</span>
        <span className="text-[11px] font-semibold" style={{ color: "#5b8cff" }}>{stateLabel}</span>
      </div> */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onPlayToggle}
          aria-label={isPlaying ? "Pause response" : "Play response"}
          className="flex-shrink-0 w-8 h-8 rounded-full grid place-items-center text-white"
          style={{ background: "var(--success-default)" }}
        >
          {isPlaying ? <FiPause size={13} /> : <FiPlay size={13} style={{ marginLeft: 1 }} />}
        </button>
        <button
          type="button"
          onClick={onReplay}
          aria-label="Replay from start"
          className="flex-shrink-0 w-8 h-8 rounded-full grid place-items-center border"
          style={{ background: "var(--primary-bg)", color: "var(--secondary-contrast)" }}
        >
          <FiRotateCcw size={13} />
        </button>
        <span className="text-[10px] w-8 flex-shrink-0" style={{ color: "var(--secondary-contrast)" }}>{formatDuration(audioCurrentTime)}</span>
        <div
          ref={barRef}
          onClick={handleBarClick}
          className="relative flex-1 h-[5px] rounded-full cursor-pointer"
          style={{ background: "#2d3240" }}
        >
          <div
            className="absolute left-0 top-0 bottom-0 rounded-full"
            style={{ width: `${progress * 100}%`, background: "linear-gradient(90deg,#5b8cff,#7c5cff)" }}
          />
          <div
            className="absolute top-1/2 w-[11px] h-[11px] rounded-full bg-white shadow"
            style={{ left: `${progress * 100}%`, transform: "translate(-50%, -50%)" }}
          />
        </div>
        <span className="text-[10px] w-8 flex-shrink-0 text-right" style={{ color: "var(--secondary-contrast)" }}>{formatDuration(audioDuration)}</span>
      </div>
    </div>
  );
}

const QUICK_INQUIRIES = [
  { category: "HR & Benefits", text: "How do I enroll in or update my benefits?" },
  { category: "HR & Payroll", text: "How do I update my W-4 or tax withholding forms?" },
  { category: "POS & Billing", text: "How do I replace or redeem a damaged gift card?" },
  { category: "Finance & Ops", text: "How do I contact travel, expense or vendor support?" },
];

const MAX_MESSAGE_LENGTH = 2000;

function AgentAvatar() {
  return <div className="w-8 h-8 flex-none rounded-full bg-[var(--maroon-primary)] text-black grid place-items-center text-lg font-extrabold">🤠</div>;
}

function MessageBubble({ item }) {
  const [showResources, setShowResources] = useState(false);
  const [showConsent, setShowConsent] = useState(true);
  const resources = item.resources || [];
  const needsConsent = Boolean(item.link) || Boolean(item.consentRequired);

  return (
    <div className={`flex gap-3 items-start ${item.sender === "user" ? "justify-end" : ""}`}>
      {/* {item.sender !== "user" && <AgentAvatar />} */}
      <div className={`max-w-[90%] p-3.5 rounded-xl text-sm break-words ${item.sender === "user" ? 'bg-[var(--success-contrast)] border border-[var(--primary-bg)] text-[var(--secondary-contrast)] rounded-br-[4px]' : 'bg-[#F2E8D2] border-l-2 border-[var(--maroon-primary)] text-[var(--secondary-contrast)] rounded-bl-[4px]'}`}>
        {item.sender !== "user" && <div className="text-[var(--maroon-primary)] text-xs font-extrabold mb-1">✦ Roadie Ranger</div>}
        <div className="chat-markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
          // components={{
          //   a: ({ node, ...props }) => (
          //     <a {...props} target="_blank" rel="noopener noreferrer" />
          //   ),
          // }}
          >{item.message}</ReactMarkdown>
        </div>

        {resources.length > 0 && (
          <div className="border-t border-emerald-900 mt-3 pt-2">
            <button type="button" onClick={() => setShowResources((value) => !value)} className="w-full flex items-center justify-between text-yellow-400 text-xs font-extrabold">
              <span>🔗 {resources.length} Sources Used</span>
              <FiChevronDown className={showResources ? "transform rotate-180" : ""} />
            </button>
            {showResources && (
              <div className="flex flex-col gap-2 mt-2">
                {resources.map((resource, index) => (
                  <a key={`${resource.url}-${index}`} href={resource.url} target="_blank" rel="noreferrer" className="flex gap-2 items-center bg-[#08281d] border border-emerald-800 rounded-lg p-2 text-sm text-gray-200 no-underline">
                    📄 <span>{resource.name || resource.url}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {needsConsent && showConsent && (
          <div className="flex gap-2 mt-3">
            <button type="button" onClick={() => { if (item.link) window.open(item.link, "_blank", "noopener,noreferrer"); setShowConsent(false); }} className="rounded-md bg-yellow-400 text-black px-3 py-1 text-sm font-bold">Grant Consent</button>
            <button type="button" onClick={() => setShowConsent(false)} className="rounded-md border px-3 py-1 text-sm">Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-3 items-start">
      <AgentAvatar />
      <div className="max-w-[80%] p-3.5 rounded-xl text-sm break-words bg-[#F2E8D2] border-l-2 border-[var(--maroon-primary)] text-gray-200">
        <div className="text-[var(--maroon-primary)] text-xs font-extrabold mb-1">✦ Roadie Ranger</div>
        <div className="flex gap-1"><span className="w-2 h-2 bg-[var(--primary-lighter)] rounded-full animate-pulse" /><span className="w-2 h-2 bg-[var(--primary-light)] rounded-full animate-pulse delay-75" /><span className="w-2 h-2 bg-[var(--primary-default)] rounded-full animate-pulse delay-150" /></div>
      </div>
    </div>
  );
}

function ChatExperience({ firstName, userInfo, userEmail, initials, sessionId, onNewChat, onLogout }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState(null); // null = choose mode on landing, 'text' or 'voice'
  const [showModeWarning, setShowModeWarning] = useState(false);
  const [pendingMode, setPendingMode] = useState(null);
  const textareaRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const messagesEndRef = useRef(null);
  const profileRef = useRef(null);
  const wasVoiceActive = useRef(false);
  const skipVoiceCloseRefresh = useRef(false);

  const addMessage = useCallback((message, sender = "ai", meta = {}) => {
    const streaming = Boolean(meta.streaming);
    setMessages((previous) => {
      if (sender === "ai" && streaming) {
        const index = [...previous].map((item, i) => ({ item, i })).reverse().find(({ item }) => item.sender === "ai" && item.streaming)?.i;
        if (index !== undefined) {
          return previous.map((item, i) => i === index ? { ...item, message: item.message + message } : item);
        }
        return [...previous, { id: `${Date.now()}-ai`, sender: "ai", message, streaming: true, ...meta }];
      }

      if (sender === "ai") {
        const index = [...previous].map((item, i) => ({ item, i })).reverse().find(({ item }) => item.sender === "ai" && item.streaming)?.i;
        if (index !== undefined) {
          return previous.map((item, i) => i === index ? {
            ...item,
            message,
            streaming: false,
            message_id: meta.message_id || item.message_id,
            link: meta.link || item.link,
            resources: meta.resources || item.resources,
            consentRequired: meta.consentRequired,
          } : item);
        }
      }

      return [...previous, { id: `${Date.now()}-${Math.random()}`, sender, message, streaming: false, ...meta }];
    });
  }, []);

  const handleLogout = useCallback(async () => {
    await onLogout();
  }, [onLogout]);

  const { sendMessage: sendTextMessage } = useTextAgent(
    addMessage,
    setLoading,
    handleLogout,
    sessionId
  );

  const audioRef = useRef(null);
  const suppressPauseNotifyRef = useRef(false);
  const playbackEndedNotifiedRef = useRef(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const formatTime = (t) => {
    if (!t && t !== 0) return "0:00";
    const sec = Math.floor(t || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleAudio = useCallback(({ url, blob, format }) => {
    try {
      if (!audioRef.current) return;
      // programmatic swap: mark suppress so pause handler doesn't notify
      if (!audioRef.current.paused) {
        suppressPauseNotifyRef.current = true;
        audioRef.current.pause();
      }
      audioRef.current.src = url;
      setAudioUrl(url);
      setAudioBlob(blob || null);
      setIsPlaying(false);
      playbackEndedNotifiedRef.current = false;
      setAgentSpeaking(true);
      // attempt to play and notify server via hook when started (hook returns notifier)
      const playPromise = audioRef.current.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.catch((err) => {
          console.warn('Autoplay blocked or failed:', err);
        });
      }
    } catch (err) {
      console.error('handleAudio error', err);
    }
  }, []);

  const handleInterrupt = useCallback(() => {
    if (!audioRef.current) return;
    if (!audioRef.current.paused) {
      suppressPauseNotifyRef.current = true; // programmatic stop, not user-initiated
      audioRef.current.pause();
    }
    audioRef.current.currentTime = 0;
    setAgentSpeaking(false);
    setIsPlaying(false);
  }, []);

  const handleReplay = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = 0;
    setAudioCurrentTime(0);
    const p = audioRef.current.play();
    if (p && p.then) p.catch(() => { });
  }, []);

  const [isRecording, setIsRecording] = useState(false);
const [pttMode, setPttMode] = useState(false);

const handleBargeIn = useCallback(() => {
  setIsRecording(true);
}, []);

  const { isVoiceActive, startVoiceSession, stopVoiceSession, startCapture, stopCapture, micLevel, status: voiceStatus,
    speakingPaused, pauseSpeaking, resumeSpeaking, notifyPlaybackStarted, notifyPlaybackEnded, setAgentSpeakingGate, interruptPlayback, setCaptureEnabled } =
    useVoiceAgent(addMessage, setLoading, { onAudio: handleAudio, onInterrupt: handleInterrupt, onBargeIn: handleBargeIn });


  const npStateLabel = !isVoiceActive ? "Idle" : speakingPaused ? "Paused" : isPlaying ? "Speaking" : "Idle";
  useEffect(() => {
    if (wasVoiceActive.current && !isVoiceActive) {
      if (skipVoiceCloseRefresh.current) {
        skipVoiceCloseRefresh.current = false;
      } else {
        void onNewChat();
      }
    }
    wasVoiceActive.current = isVoiceActive;
  }, [isVoiceActive, onNewChat]);

  useEffect(() => {
    // Mic (and its UI indicator) always starts muted/idle on a fresh
    // session — this now matches the actual capture state coming from
    // aiVoiceResponse.jsx, which no longer auto-enables the microphone on
    // connect. (Removed a duplicate copy of this effect that ran twice.)
    if (!isVoiceActive) {
      setIsRecording(false);
    }
  }, [isVoiceActive]);

  useEffect(() => {
    if (messages.length === 0) return;
    requestAnimationFrame(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "auto", // instant — avoids "smooth" being interrupted mid-stream by rapid token updates
      });
    });
  }, [messages, loading]);

  useEffect(() => {
    const handleOutside = (event) => {
      if (profileRef.current && !profileRef.current.contains(event.target)) setShowProfile(false);
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || loading || isVoiceActive) return;
    addMessage(text, "user");
    setDraft("");
    void sendTextMessage(text);
  }, [addMessage, draft, isVoiceActive, loading, sendTextMessage]);

  const selectInquiry = useCallback((text) => {
    // kept for legacy use; prefer populateQuery
    if (loading || isVoiceActive) return;
    addMessage(text, "user");
    void sendTextMessage(text);
  }, [addMessage, isVoiceActive, loading, sendTextMessage]);

  const populateQuery = useCallback((text) => {
    // place query into input instead of sending
    if (isVoiceActive) return;
    setMode("text");
    setDraft(text);
    // focus the textarea after it renders
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [isVoiceActive]);

  const requestModeChange = useCallback((nextMode) => {
    if (!nextMode || nextMode === mode) {
      setShowModeWarning(false);
      setPendingMode(null);
      return;
    }
    setPendingMode(nextMode);
    setShowModeWarning(true);
  }, [mode]);

  const confirmModeChange = useCallback(async () => {
    if (!pendingMode) {
      setShowModeWarning(false);
      return;
    }
    setMessages([]);
    setDraft("");
    if (pendingMode === "text" && isVoiceActive) {
      skipVoiceCloseRefresh.current = true;
      setIsRecording(false);
      setIsPlaying(false);
      setAudioUrl(null);
      setAudioBlob(null);
      setAudioCurrentTime(0);
      setAudioDuration(0);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load?.();
      }
      stopVoiceSession();
    }
    await onNewChat();
    setMode(pendingMode);
    setPendingMode(null);
    setShowModeWarning(false);
  }, [isVoiceActive, onNewChat, pendingMode, stopVoiceSession]);

  const togglePttMode = useCallback(() => {
    setPttMode((prev) => {
      const next = !prev;
      // Push-to-talk mode disables the always-on microphone until press.
      if (next) {
        try { stopCapture(); } catch (err) { console.error(err); }
        setIsRecording(false);
      } else if (isVoiceActive) {
        setCaptureEnabled(true);
      }
      return next;
    });
  }, [isVoiceActive, setCaptureEnabled, stopCapture]);

  const handleMicClick = useCallback(async () => {
    if (!isVoiceActive || pttMode) return; // click-to-toggle only applies in mute/unmute mode
    if (isRecording) {
      try { stopCapture(); } catch (err) { console.error(err); }
      setIsRecording(false);
    } else {
      setIsRecording(true);
      try { await startCapture(); } catch (err) { console.error(err); }
    }
  }, [isVoiceActive, pttMode, isRecording, startCapture, stopCapture]);

  const startMicCapture = useCallback(async () => {
    if (!isVoiceActive) return;
    setIsRecording(true);
    try { await startCapture(); } catch (err) { console.error(err); }
  }, [isVoiceActive, startCapture]);

  const handleDisconnect = useCallback(() => {
    setMessages([]);
    setDraft("");
    setIsRecording(false);
    setIsPlaying(false);
    setAudioUrl(null);
    setAudioBlob(null);
    setAudioCurrentTime(0);
    setAudioDuration(0);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load?.();
    }
    stopVoiceSession();
  }, [stopVoiceSession]);

  const conversationStarted = messages.length > 0;
  const modeSelected = mode !== null;
  const inputPlaceholder = isVoiceActive
    ? `Voice active (${voiceStatus})...`
    : "You are currently in text mode. To continue with voice mode, create a new voice chat.";

  const handleModeSelection = useCallback(async (nextMode) => {
    if (!nextMode) return;

    if (mode === null) {
      setMessages([]);
      setDraft("");
      setPendingMode(null);
      setShowModeWarning(false);
      // ensure any previous voice session is stopped and player reset
      try { stopVoiceSession(); } catch (err) { /* ignore */ }
      try { if (audioRef.current) { audioRef.current.pause(); audioRef.current.removeAttribute('src'); audioRef.current.load?.(); } } catch (e) {}
      setAudioUrl(null); setAudioBlob(null); setAudioCurrentTime(0); setAudioDuration(0); setIsPlaying(false);
      await onNewChat();
      setMode(nextMode);
      return;
    }

    if (nextMode === mode) {
      setMessages([]);
      setDraft("");
      setPendingMode(null);
      setShowModeWarning(false);
      // Reset voice session and player when starting a fresh chat in the same mode
      try { stopVoiceSession(); } catch (err) { /* ignore */ }
      try { if (audioRef.current) { audioRef.current.pause(); audioRef.current.removeAttribute('src'); audioRef.current.load?.(); } } catch (e) {}
      setAudioUrl(null); setAudioBlob(null); setAudioCurrentTime(0); setAudioDuration(0); setIsPlaying(false);
      await onNewChat();
      setMode(nextMode);
      return;
    }

    requestModeChange(nextMode);
  }, [mode, onNewChat, requestModeChange]);

  return (
    <main className="min-h-screen bg-[#faf5ea] text-gray-200 font-sans flex flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-emerald-900 bg-[var(--maroon-primary)] px-3 py-2.5 sticky top-0 z-20 shrink-0 sm:px-5 md:px-8">
        <div className="flex items-center gap-2 min-w-0 sm:gap-3">
          <div className="flex h-[36px] w-[36px] shrink-0 sm:h-[42px] sm:w-[42px]">
            <img
              src={texasLogo}
              alt="Texas Roadhouse Home"
              className="h-full w-auto object-contain cursor-pointer"
              role="button"
              aria-label="Go to home"
              onClick={() => {
                // Reset UI to home state and start a fresh chat
                setMessages([]);
                setMode(null);
                void onNewChat();
              }}
            />
          </div>
          <div className="w-7 h-7 rounded-full bg-[var(--maroon-primary)] border border-[var(--neutral-400)] text-black grid place-items-center text-sm font-extrabold sm:w-8 sm:h-8 sm:text-base">🤠</div>
          <div className="min-w-0">
            <div className="font-extrabold text-[11px] leading-none sm:text-sm">Roadie Ranger</div>
            <div className="text-[9px] text-emerald-300 mt-0.5 flex items-center sm:text-[10px]"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--success-default)] mr-1.5" /> Online now</div>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {!modeSelected ? (
            // <button type="button" onClick={onNewChat} className="inline-flex items-center justify-center gap-1 border border-emerald-800 bg-[var(--success-default)] text-white rounded-full px-2.5 py-1.5 text-[10px] font-bold sm:gap-1.5 sm:px-3 sm:text-xs hover:border-yellow-400">
            //   <FiPlus className="text-[10px] sm:text-xs" /> New Chat
            // </button>
            null
          ) : (
            <div className="flex items-center gap-2">
              <button type="button" title="Start a new text chat" onClick={() => handleModeSelection("text")} className={`inline-flex gap-2 cursor-pointer items-center justify-center rounded-full border px-2.5 py-1.5 text-[10px] font-bold sm:px-3 sm:text-xs ${mode === "text" ? "border-[var(--primary-default)] bg-[var(--primary-default)] text-white" : "border-emerald-800 bg-[#102a20] text-gray-200"}`}>
                <FiPlus className="text-[10px] sm:text-xs" /> Text Chat
              </button>
              <button type="button" title="Start a new voice chat" onClick={() => handleModeSelection("voice")} className={`inline-flex gap-2 cursor-pointer items-center justify-center rounded-full border px-2.5 py-1.5 text-[10px] font-bold sm:px-3 sm:text-xs ${mode === "voice" ? "border-[var(--danger-default)] bg-[var(--danger-default)] text-white" : "border-emerald-800 bg-[#102a20] text-gray-200"}`}>
                <FiPlus className="text-[10px] sm:text-xs" /> Voice Chat
              </button>
            </div>
          )}
          <div className="relative" ref={profileRef}>
            <button type="button" onClick={() => setShowProfile((value) => !value)} className="w-8 h-8 rounded-full border border-yellow-400 bg-yellow-400 text-black font-bold grid place-items-center text-xs sm:w-9 sm:h-9">
              {userInfo ? initials : <FaUser />}
            </button>
            {showProfile && (
              <div className="absolute right-0 top-10 min-w-[140px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg z-50 sm:top-12">
                <div className="border-b border-gray-100 px-4 py-3">
                  <p className="truncate text-sm font-semibold text-gray-900">{userInfo || "Roadie"}</p>
                  <p className="truncate text-xs text-gray-500">{userEmail || ""}</p>
                </div>
                <button type="button" onClick={onLogout} className="w-full flex items-center justify-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer"><FiLogOut size={16} /> Logout</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <section className={`mx-auto w-full max-w-[900px] px-3 py-6 flex-1 flex flex-col min-h-0 sm:px-4 sm:py-8 md:py-10 lg:py-5 ${conversationStarted ? "" : ""}`}>
        {!conversationStarted && !modeSelected && (
          <div className="text-center transition-all">
            <h1 className="m-0 mb-3 text-[var(--secondary-contrast)] text-2xl leading-tight font-extrabold tracking-tight sm:mb-4 sm:text-3xl md:text-4xl lg:text-5xl">Hey{firstName ? ` ${firstName}` : ""}, how can we help today?</h1>
            <p className="text-[var(--secondary-contrast)] max-w-[750px] mx-auto mb-2 text-sm sm:mb-3 sm:text-base"><strong>I'm Roadie Ranger</strong> — your quick-answer sidekick on the floor.</p>
            <p className="text-[var(--secondary-contrast)] max-w-[750px] mx-auto mb-3 text-sm sm:text-base">Roadie Ranger is your helpdesk assistant for HR, payroll, IT, store ops, travel, and compliance questions. Can't find an answer? It opens a ticket and tracks it for you.</p>
            <div className="mt-4 text-[var(--primary-bg)] font-extrabold text-xs sm:mt-6 sm:text-sm">Need help right now? I'm just a tap away.</div>
          </div>
        )}

        <div className="flex flex-col gap-3 sm:gap-4 flex-1 min-h-0 overflow-visible p-1 sm:p-2" role="log" aria-live="polite">
          {messages.map((item) => <MessageBubble key={item.id} item={item} />)}
          {loading && <TypingIndicator />}
          <div ref={messagesEndRef} />
        </div>
        {mode === null && (
          <div className="w-full flex justify-center px-1 py-3 sm:px-4 sm:py-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
              <button
                type="button"
                onClick={() => handleModeSelection("text")}
                className="flex items-center justify-center gap-2 rounded-lg border border-[var(--neutral-300)] bg-[var(--white-100)] px-4 py-2.5 text-sm font-bold text-[var(--text-muted)] transition hover:border-[var(--primary-default)] sm:px-5 sm:py-3"
              >
                <FiMessageSquare className="text-base" />
                Text Mode
              </button>

              <button
                type="button"
                onClick={() => handleModeSelection("voice")}
                className="flex items-center justify-center gap-2 rounded-lg border border-[var(--neutral-300)] bg-[var(--white-100)] px-4 py-2.5 text-sm font-bold text-[var(--text-muted)] transition hover:border-[var(--primary-default)] sm:px-5 sm:py-3"
              >
                <FiMic className="text-base" />
                Voice Mode
              </button>
            </div>
          </div>
        )}
        <section className="sticky bottom-0 z-10 mt-auto w-full shrink-0 bg-[#faf5ea] pt-2 pb-0">
          <div className="flex items-end gap-2 sm:gap-3">
            {mode === "text" && (
              <div className="relative flex-1">
                <textarea
                  ref={textareaRef}
                  className="flex items-center w-full max-h-[150px] overflow-hidden resize-none rounded-2xl border border-emerald-800 bg-[#f6f1e6] text-[10px] text-[var(--secondary-contrast)] px-3 py-3 pr-12 placeholder:text-[var(--text-muted)] focus:outline-none sm:text-base"
                  value={draft}
                  rows={1}
                  disabled={isVoiceActive}
                  placeholder={inputPlaceholder}
                  onChange={(event) => {
                    const textarea = event.target;
                    textarea.style.height = "auto";
                    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
                    setDraft(textarea.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={!draft.trim() || loading || isVoiceActive}
                  onClick={submit}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full grid place-items-center ${!draft.trim() || loading || isVoiceActive ? 'bg-[var(--success-default)] text-[--success-contrast] border border-emerald-900 cursor-not-allowed' : 'bg-[var(--primary-bg)] text-black cursor-pointer border border-yellow-400'}`}
                >
                  <FiSend className="text-sm" />
                </button>
              </div>
            )}



            {mode === null && (
              <div className="flex-1 min-h-[46px] rounded-2xl border border-dashed border-emerald-800/60 bg-[#f6f1e6]/60 px-4 py-3.5 flex items-center justify-center gap-2.5 sm:py-4">
                <p className="m-0 text-sm text-[var(--text-muted)] font-medium sm:text-base flex items-center flex-wrap gap-x-1.5 justify-center">
                  <span>Pick</span>
                  <span className="inline-flex items-center gap-1 text-[var(--secondary-contrast)] font-bold">
                    <FiMessageSquare className="text-base opacity-60" /> Text
                  </span>
                  <span>or</span>
                  <span className="inline-flex items-center gap-1 text-[var(--secondary-contrast)] font-bold">
                    <FiMic className="text-base opacity-60" /> Voice
                  </span>
                  <span>mode above to start chatting</span>
                </p>
              </div>
            )}

            {mode === "voice" && (
              <div className="flex-1 flex flex-col gap-3 rounded-2xl border border-emerald-800 bg-[#f6f1e6] p-4">
                {/* <p className="text-black">Coming soon... please switch to text mode to continue.</p> */}
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    {/* <div className="flex items-center justify-center">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => startVoiceSession()}
                          disabled={isVoiceActive}
                          className="px-2 py-1 text-xs rounded-md font-semibold transition bg-[var(--primary-bg)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isVoiceActive ? "Connected" : "Connect"}
                        </button>

                        

                      </div>
                    </div> */}

                    <div className="mt-3 flex items-center gap-3">
                      <div className="w-full">
                        <CurrentResponsePlayer
                          audioCurrentTime={audioCurrentTime}
                          audioDuration={audioDuration}
                          isPlaying={isPlaying}
                          stateLabel={npStateLabel}
                          onSeek={(t) => {
                            if (!audioRef.current) return;
                            audioRef.current.currentTime = t;
                            setAudioCurrentTime(t);
                          }}
                          onPlayToggle={() => {
                            if (!audioRef.current) return;
                            if (audioRef.current.paused) {
                              const p = audioRef.current.play();
                              if (p && p.then) p.catch(() => { });
                              // rely on audio element onPlay to set playing state and notify server
                            } else {
                              audioRef.current.pause();
                              pauseSpeaking?.();
                            }
                          }}
                          onReplay={handleReplay}
                        />
                      </div>
                    </div>
                    <div className="relative mt-5 flex min-h-14 w-full items-center justify-center">
                      <button
                        type="button"
                        onClick={togglePttMode}
                        aria-pressed={pttMode}
                        title={pttMode ? "Switch to always-on microphone" : "Switch to push-to-talk"}
                        className="absolute left-0 flex items-center gap-2"
                      >
                        <span className={`relative inline-block w-9 h-5 rounded-full transition-colors ${pttMode ? 'bg-[var(--success-default)]' : 'bg-gray-300'}`}>
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${pttMode ? 'translate-x-4' : 'translate-x-0'}`} />
                        </span>
                        <span className="text-[10px] font-bold text-[var(--secondary-contrast)] whitespace-nowrap">
                          {pttMode ? "Push-to-talk" : "Microphone"}
                        </span>
                      </button>
                      <div className="flex flex-row items-center justify-center gap-2">
                      
                      <button
                        type="button"
                        onClick={() => startVoiceSession()}
                        disabled={isVoiceActive}
                        className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed ${
                          isVoiceActive
                            ? "bg-[var(--primary-default)] text-white"
                            : "bg-[var(--primary-bg)]"
                        }`}
                      >
                        {isVoiceActive ? <FiCheckCircle aria-hidden="true" /> : <FiLink aria-hidden="true" />}
                        {isVoiceActive ? "Connected" : "Connect"}
                      </button>
                      <button
                        type="button"
                        onClick={handleMicClick}
                        onMouseDown={async (e) => {
                          e.preventDefault();
                          if (!isVoiceActive || !pttMode) return;
                          await startMicCapture();
                        }}
                        onMouseUp={async (e) => {
                          e.preventDefault();
                          if (!isVoiceActive || !pttMode) return;
                          try { stopCapture(); } catch (err) { console.error(err); }
                          setIsRecording(false);
                        }}
                        onMouseLeave={async (e) => {
                          if (!isVoiceActive || !pttMode) return;
                          try { stopCapture(); } catch (err) { console.error(err); }
                          setIsRecording(false);
                        }}
                        onTouchStart={async (e) => {
                          e.preventDefault();
                          if (!isVoiceActive || !pttMode) return;
                          setIsRecording(true);
                          await startMicCapture();
                        }}
                        onTouchEnd={async (e) => {
                          e.preventDefault();
                          if (!isVoiceActive || !pttMode) return;
                          try { stopCapture(); } catch (err) { console.error(err); }
                          setIsRecording(false);
                        }}
                        title={
                          pttMode
                            ? "Hold to talk (push-to-talk)"
                            : (isRecording ? "Click to mute" : "Click to unmute")
                        }
                        aria-label={
                          !isVoiceActive
                            ? "Connect first to speak"
                            : pttMode
                              ? "Hold to speak"
                              : (isRecording ? "Click to mute microphone" : "Click to unmute microphone")
                        }
                        className={`w-14 h-14 rounded-full grid place-items-center text-2xl shadow-md transition-colors ${isVoiceActive ? (isRecording ? 'bg-[var(--success-default)] text-white mic-recording' : 'bg-[var(--primary-bg)] text-white') : 'bg-[var(--primary-bg)] text-white'}`}
                      >
                        {isRecording ? '🎤' : '🎙️'}
                      </button>
                      <button
                        type="button"
                        onClick={handleDisconnect}
                        disabled={!isVoiceActive}
                        className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md font-semibold transition ${!isVoiceActive ? 'opacity-50 cursor-not-allowed bg-white text-[var(--text-muted)]' : 'bg-[var(--danger-default)] text-white'}`}
                      >
                        <FiPower aria-hidden="true" />
                        Disconnect
                      </button>

                      

                      </div>
                    </div>
                  </div>
                </div>
                

                <audio ref={audioRef} id="player" className="hidden" onLoadedMetadata={() => {
                  try { setAudioDuration(audioRef.current?.duration || 0); } catch (_) { setAudioDuration(0); }
                }} onTimeUpdate={() => {
                  try { setAudioCurrentTime(audioRef.current?.currentTime || 0); } catch (_) { setAudioCurrentTime(0); }
                }} onPlaying={() => {
                  setIsPlaying(true);
                  notifyPlaybackStarted();
                  setAgentSpeaking(true);
                  setAgentSpeakingGate?.(true);
                  playbackEndedNotifiedRef.current = false;
                }} onWaiting={() => {
                  setIsPlaying(false);
                }} onPause={() => {
                  setIsPlaying(false);
                  setAgentSpeakingGate?.(false);
                  if (suppressPauseNotifyRef.current) { suppressPauseNotifyRef.current = false; return; }
                  if (!playbackEndedNotifiedRef.current) {
                    playbackEndedNotifiedRef.current = true;
                    notifyPlaybackEnded();
                    setAgentSpeaking(false);
                  }
                }} onEnded={() => {
                  setIsPlaying(false);
                  setAgentSpeakingGate?.(false);
                  if (!playbackEndedNotifiedRef.current) { playbackEndedNotifiedRef.current = true; notifyPlaybackEnded(); setAgentSpeaking(false); }
                }} />
              </div>
            )}
          </div>
          {/* Mode switch warning popup */}
          <WarningPopUp
            isOpen={showModeWarning}
            onClose={() => {
              setPendingMode(null);
              setShowModeWarning(false);
            }}
            onContinue={confirmModeChange}
            message={
              pendingMode === "voice"
                ? "Switching to voice mode will close this text conversation. Would you like to continue?"
                : pendingMode === "text"
                  ? "Switching to text mode will close this voice conversation. Would you like to continue?"
                  : "Are you sure you want to switch modes?"
            }
          />
        </section>

        {!conversationStarted && !modeSelected && (
          <section className="mt-7">
            <div className="text-[10px] font-extrabold text-[var(--success-default)] tracking-wider mb-3 sm:text-xs">POPULAR ROADIE INQUIRIES:</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3">
              {QUICK_INQUIRIES.map((inquiry) => (
                <button
                  key={inquiry.text}
                  type="button"
                  onClick={() => {
                    if (mode === "voice") return;
                    populateQuery(inquiry.text);
                  }}
                  disabled={mode === "voice"}
                  className={`bg-[var(--primary-contrast)] border border-[var(--primary-default)] rounded-xl p-4 text-left text-white transition ${mode === "voice" ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <div className="flex justify-between items-center mb-2">
                    <span className="bg-[var(--neutral-200)] text-[var(--primary-default)] rounded-full px-3 py-1 text-xs font-extrabold">{inquiry.category}</span>
                    <b className="text-emerald-600">❯</b>
                  </div>
                  <p className="m-0 text-[12px] font-[500] text-[var(--secondary-contrast)] leading-tight">"{inquiry.text}"</p>
                </button>
              ))}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

const LandingPage = () => {
  const [userInfo, setUserInfo] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [sessionId, setSessionId] = useState("");

  useEffect(() => {
    const cachedName = sessionStorage.getItem("userInfo");
    const cachedEmail = sessionStorage.getItem("userEmail");
    if (cachedName) setUserInfo(cachedName);
    if (cachedEmail) setUserEmail(cachedEmail);

    const fetchUserDetails = async () => {
      try {
        const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
        const response = await fetch(`${apiBase || ''}/get_user_details`, {
          method: "GET",
          credentials: "include",
        });
        if (!response.ok) return;
        const responseData = await response.json();
        const data = responseData.data || {};
        const name = data.name || "";
        const email = data.preferred_username || "";
        if (name) sessionStorage.setItem("userInfo", name);
        if (email) sessionStorage.setItem("userEmail", email);
        setUserInfo(name);
        setUserEmail(email);
      } catch (error) {
        console.error("Failed to fetch user details:", error);
      }
    };
    void fetchUserDetails();
  }, []);

  const handleNewChat = useCallback(async () => {
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
      const response = await fetch(`${apiBase || ''}/api/get_conversation_id`, {
        method: "GET",
        credentials: "include",
      });
      if (response.ok) {
        const data = await response.json();
        const conversationId = data.conversation_id || "";
        setSessionId(conversationId);
        return conversationId;
      }
    } catch (error) {
      console.error("Failed to start new chat session:", error);
    }
    return "";
  }, []);

  useEffect(() => {
    void handleNewChat();
  }, [handleNewChat]);

  const handleLogout = useCallback(async () => {
    sessionStorage.removeItem("userInfo");
    sessionStorage.removeItem("userEmail");
    try {
      await fetch("/logout", { method: "POST", credentials: "include" });
    } finally {
      window.location.href = "/";
    }
  }, []);

  const firstName = useMemo(() => userInfo ? userInfo.split(" ")[0] : "Roadie", [userInfo]);
  const initials = useMemo(() => {
    if (!userInfo) return '';
    const parts = userInfo.trim().split(/\s+/);
    const first = parts[0] ? parts[0][0] : '';
    const second = parts[1] ? parts[1][0] : '';
    const combined = (first + second).toUpperCase();
    return combined || (first || '').toUpperCase();
  }, [userInfo]);

  return (
    <ChatExperience
      firstName={firstName}
      userInfo={userInfo}
      userEmail={userEmail}
      initials={initials}
      sessionId={sessionId}
      onNewChat={handleNewChat}
      onLogout={handleLogout}
    />
  );
};

export default LandingPage;
