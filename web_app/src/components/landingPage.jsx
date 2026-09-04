import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaUser } from "react-icons/fa";
import { FiLogOut, FiPlus, FiSend, FiMic, FiSquare, FiChevronDown, FiMessageSquare } from "react-icons/fi";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useTextAgent from "./aiTextResponse.jsx";
import useVoiceAgent from "./aiVoiceResponse.jsx";
import WarningPopUp from "./warningPopUp.jsx";
import texasLogo from "../assets/texas-logo.png";

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
      <div className={`max-w-[80%] p-3.5 rounded-xl text-sm break-words ${item.sender === "user" ? 'bg-[var(--success-contrast)] border border-[var(--primary-bg)] text-[var(--secondary-contrast)] rounded-br-[4px]' : 'bg-[#F2E8D2] border-l-2 border-[var(--maroon-primary)] text-[var(--secondary-contrast)] rounded-bl-[4px]'}`}>
        {item.sender !== "user" && <div className="text-[var(--maroon-primary)] text-xs font-extrabold mb-1">✦ Roadie Ranger</div>}
        <div>
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
            <button type="button" onClick={() => item.link && window.open(item.link, "_blank", "noopener,noreferrer")} className="rounded-md bg-yellow-400 text-black px-3 py-1 text-sm font-bold">Grant Consent</button>
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
        <div className="flex gap-1"><span className="w-2 h-2 bg-[var(--primary-lighter)] rounded-full animate-pulse"/><span className="w-2 h-2 bg-[var(--primary-light)] rounded-full animate-pulse delay-75"/><span className="w-2 h-2 bg-[var(--primary-default)] rounded-full animate-pulse delay-150"/></div>
      </div>
    </div>
  );
}

function ChatExperience({ firstName, userInfo, initials, sessionId, onNewChat, onLogout }) {
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

  const handleAudio = useCallback(({ url, blob, format }) => {
    try {
      if (!audioRef.current) return;
      // programmatic swap: mark suppress so pause handler doesn't notify
      if (!audioRef.current.paused) {
        suppressPauseNotifyRef.current = true;
        audioRef.current.pause();
      }
      audioRef.current.src = url;
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

  const { isVoiceActive, startVoiceSession, stopVoiceSession, micLevel, status: voiceStatus, speakingPaused, pauseSpeaking, resumeSpeaking, notifyPlaybackStarted, notifyPlaybackEnded } = useVoiceAgent(
    addMessage,
    setLoading,
    { onAudio: handleAudio }
  );

  useEffect(() => {
    if (wasVoiceActive.current && !isVoiceActive) {
      onNewChat();
    }
    wasVoiceActive.current = isVoiceActive;
  }, [isVoiceActive, onNewChat]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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

  const confirmModeChange = useCallback(() => {
    if (!pendingMode) {
      setShowModeWarning(false);
      return;
    }
    setMessages([]);
    setDraft("");
    onNewChat();
    setMode(pendingMode);
    setPendingMode(null);
    setShowModeWarning(false);
  }, [onNewChat, pendingMode]);

  const conversationStarted = messages.length > 0;
  const modeSelected = mode !== null;
  const inputPlaceholder = isVoiceActive
    ? `Voice active (${voiceStatus})...`
    : "Text mode is active to switch to voice mode create a voice chat";

  const handleModeSelection = useCallback((nextMode) => {
    if (!nextMode) return;

    if (mode === null) {
      setMessages([]);
      setDraft("");
      setPendingMode(null);
      setShowModeWarning(false);
      setMode(nextMode);
      onNewChat();
      return;
    }

    if (nextMode === mode) {
      setMessages([]);
      setDraft("");
      setPendingMode(null);
      setShowModeWarning(false);
      setMode(nextMode);
      onNewChat();
      return;
    }

    requestModeChange(nextMode);
  }, [mode, onNewChat, requestModeChange]);

  return (
    <main className="min-h-screen bg-[#faf5ea] text-gray-200 font-sans flex flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-emerald-900 bg-[var(--maroon-primary)] px-3 py-2.5 sticky top-0 z-20 shrink-0 sm:px-5 md:px-8">
        <div className="flex items-center gap-2 min-w-0 sm:gap-3">
          <div className="flex h-[36px] w-[36px] shrink-0 sm:h-[42px] sm:w-[42px]">
            <img src={texasLogo} alt="" className="h-full w-auto object-contain" />
          </div>
          <div className="w-7 h-7 rounded-full bg-[var(--maroon-primary)] border border-[var(--neutral-400)] text-black grid place-items-center text-sm font-extrabold sm:w-8 sm:h-8 sm:text-base">🤠</div>
          <div className="min-w-0">
            <div className="font-extrabold text-[11px] leading-none sm:text-sm">Roadie Ranger</div>
            <div className="text-[9px] text-emerald-300 mt-0.5 flex items-center sm:text-[10px]"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--success-default)] mr-1.5"/> Online now</div>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {!modeSelected ? (
            <button type="button" onClick={onNewChat} className="inline-flex items-center justify-center gap-1 border border-emerald-800 bg-[var(--success-default)] text-white rounded-full px-2.5 py-1.5 text-[10px] font-bold sm:gap-1.5 sm:px-3 sm:text-xs hover:border-yellow-400">
              <FiPlus className="text-[10px] sm:text-xs" /> New Chat
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => handleModeSelection("text")} className={`inline-flex items-center justify-center rounded-full border px-2.5 py-1.5 text-[10px] font-bold sm:px-3 sm:text-xs ${mode === "text" ? "border-[var(--primary-default)] bg-[var(--primary-default)] text-white" : "border-emerald-800 bg-[#102a20] text-gray-200"}`}>
                Text Chat
              </button>
              <button type="button" onClick={() => handleModeSelection("voice")} className={`inline-flex items-center justify-center rounded-full border px-2.5 py-1.5 text-[10px] font-bold sm:px-3 sm:text-xs ${mode === "voice" ? "border-[var(--danger-default)] bg-[var(--danger-default)] text-white" : "border-emerald-800 bg-[#102a20] text-gray-200"}`}>
                Voice Chat
              </button>
            </div>
          )}
          <div className="relative" ref={profileRef}>
            <button type="button" onClick={() => setShowProfile((value) => !value)} className="w-8 h-8 rounded-full border border-yellow-400 bg-yellow-400 text-black font-bold grid place-items-center text-xs sm:w-9 sm:h-9">
              {userInfo ? initials : <FaUser />}
            </button>
            {showProfile && (
              <div className="absolute right-0 top-10 w-36 bg-[#0c1a15] border border-[#1c362d] rounded-xl p-2 shadow-lg sm:w-40 sm:top-12">
                <div className="px-2 py-2 text-xs text-gray-200 font-bold sm:text-sm">{firstName || "Roadie"}</div>
                <button type="button" onClick={onLogout} className="w-full flex items-center gap-2 text-xs text-gray-200 p-2 rounded-md hover:bg-emerald-900 sm:text-sm"><FiLogOut /> Logout</button>
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
            <p className="text-[var(--secondary-contrast)] max-w-[750px] mx-auto mb-3 text-sm sm:text-base">Ask me anything you need help with, from HR and payroll to restaurant operations and day-to-day tasks. I'll get you clear, trusted guidance in seconds.</p>
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
                <span className="flex items-center gap-3 text-[var(--text-muted)]">
                  <FiMessageSquare className="text-base opacity-60" />
                  <FiMic className="text-base opacity-60 -ml-1" />
                </span>
                <p className="m-0 text-sm text-[var(--text-muted)] font-medium sm:text-base">
                  Pick <span className="text-[var(--secondary-contrast)] font-bold">Text</span> or{" "}
                  <span className="text-[var(--secondary-contrast)] font-bold">Voice</span> mode above to start chatting
                </p>
              </div>
            )}

            {mode === "voice" && (
              <div className="flex-1 flex flex-col gap-2 rounded-2xl border border-emerald-800 bg-[#f6f1e6] p-3">
                <div className="flex items-center gap-4">
                  <div className={`w-14 h-14 rounded-full grid place-items-center ${isVoiceActive ? 'bg-[var(--danger-default)]' : 'bg-[#102a20]'} text-white`} style={{ boxShadow: isVoiceActive && !speakingPaused ? `0 0 ${8 + micLevel * 18}px rgba(255,99,71,0.45)` : 'none' }}>
                    <div className="text-2xl">{isVoiceActive ? '🎙️' : '🤖'}</div>
                  </div>

                  <div className="flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-bold text-[var(--secondary-contrast)]">Live voice session {isVoiceActive ? `· ${voiceStatus}` : ''}</div>
                      <div className="text-xs text-[var(--text-muted)]">{agentSpeaking ? (speakingPaused ? 'Playback paused' : 'Speaking') : 'Idle'}</div>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (audioRef.current) {
                            if (audioRef.current.paused) {
                              const p = audioRef.current.play();
                              if (p && p.then) p.catch(() => {});
                              notifyPlaybackStarted();
                              setAgentSpeaking(true);
                            } else {
                              audioRef.current.pause();
                            }
                          }
                        }}
                        className={`w-9 h-9 rounded-full grid place-items-center cursor-pointer ${audioRef.current && !audioRef.current?.paused ? 'bg-[var(--neutral-800)] text-white' : 'bg-[var(--primary-default)] text-black'}`}
                      >
                        {audioRef.current && !audioRef.current.paused ? '⏸' : '▶️'}
                      </button>

                      <button
                        type="button"
                        onClick={() => (isVoiceActive ? stopVoiceSession() : startVoiceSession())}
                        aria-label={isVoiceActive ? "Stop voice" : "Start voice"}
                        className={`w-9 h-9 rounded-full grid place-items-center cursor-pointer border border-emerald-800 ${isVoiceActive ? 'bg-red-600 text-white' : 'bg-[#102a20] text-gray-200'}`}
                      >
                        {isVoiceActive ? <FiSquare /> : <FiMic />}
                      </button>

                      <div className="flex-1 h-3 bg-[#08281d] rounded-full overflow-hidden" aria-hidden>
                        <div className="h-full bg-[var(--danger-default)]" style={{ width: `${Math.min(100, Math.round(micLevel * 100))}%`, transition: 'width 120ms linear' }} />
                      </div>
                    </div>
                  </div>
                </div>

                <audio ref={audioRef} id="player" controls onPlay={() => { notifyPlaybackStarted(); setAgentSpeaking(true); playbackEndedNotifiedRef.current = false; }} onPause={() => {
                  if (suppressPauseNotifyRef.current) { suppressPauseNotifyRef.current = false; return; }
                  if (!playbackEndedNotifiedRef.current) {
                    playbackEndedNotifiedRef.current = true;
                    notifyPlaybackEnded();
                    setAgentSpeaking(false);
                  }
                }} onEnded={() => { if (!playbackEndedNotifiedRef.current) { playbackEndedNotifiedRef.current = true; notifyPlaybackEnded(); setAgentSpeaking(false); } }} />
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
                ? "Switching to voice mode will end the current text session. Continue?"
                : pendingMode === "text"
                  ? "Switching to text mode will end the current voice session. Continue?"
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
        const response = await fetch("https://txrh-app-roadierangerdev-6279-stosup-phmo.azurewebsites.net/get_user_details", {
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
      const response = await fetch("https://txrh-app-roadierangerdev-6279-stosup-phmo.azurewebsites.net/api/get_conversation_id", {
        method: "GET",
        credentials: "include",
      });
      if (response.ok) {
        const data = await response.json();
        setSessionId(data.conversation_id || "");
      }
    } catch (error) {
      console.error("Failed to start new chat session:", error);
    }
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
      initials={initials}
      sessionId={sessionId}
      onNewChat={handleNewChat}
      onLogout={handleLogout}
    />
  );
};

export default LandingPage;
