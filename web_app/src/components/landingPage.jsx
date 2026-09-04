import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaUser } from "react-icons/fa";
import { FiLogOut, FiPlus, FiSend, FiMic, FiSquare, FiChevronDown } from "react-icons/fi";
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

function ChatExperience({ firstName, sessionId, onNewChat, onLogout }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState(null); // null = choose mode on landing, 'text' or 'voice'
  const [showModeWarning, setShowModeWarning] = useState(false);
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

  const { isVoiceActive, startVoiceSession, stopVoiceSession, micLevel, status: voiceStatus } = useVoiceAgent(
    addMessage,
    setLoading
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

  const conversationStarted = messages.length > 0;
  const inputPlaceholder = isVoiceActive
    ? `Voice active (${voiceStatus})...`
    : "Ask Roadie Ranger anything... (e.g., benefits, W-4, gift cards, POS, travel & expense)";

  return (
    <main className="min-h-screen bg-[#faf5ea] text-gray-200 font-sans flex flex-col">
      <header className="h-20 flex items-center justify-between px-8 border-b border-emerald-900 bg-[var(--maroon-primary)] sticky top-0 z-20">
        
        <div className="flex items-center gap-3">
          <div className="flex h-[50px] ml-3 ">
            <img src={texasLogo} alt="" />
          </div>
          <div className="w-9 h-9 ml-5 rounded-full  bg-[var(--maroon-primary)] border border-[var(--neutral-400)] text-black grid place-items-center text-lg font-extrabold">🤠</div>
          <div>
            <div className="font-extrabold text-sm">Roadie Ranger</div>
            <div className="text-xs text-emerald-300 mt-0.5 flex items-center"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--success-default)] mr-2"/> Online now</div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button type="button" onClick={onNewChat} className="inline-flex items-center gap-2 border border-emerald-800 bg-[var(--success-default)] text-white rounded-full px-3 py-2 font-bold text-sm hover:border-yellow-400">
            <FiPlus /> New Chat
          </button>
          <div className="relative" ref={profileRef}>
            <button type="button" onClick={() => setShowProfile((value) => !value)} className="w-9 h-9 rounded-full border border-yellow-400 bg-yellow-400 text-black font-bold grid place-items-center">
              {firstName ? firstName.slice(0, 2).toUpperCase() : <FaUser />}
            </button>
            {showProfile && (
              <div className="absolute right-0 top-12 w-44 bg-[#0c1a15] border border-[#1c362d] rounded-xl p-2 shadow-lg">
                <div className="px-2 py-2 text-sm text-gray-200 font-bold">{firstName || "Roadie"}</div>
                <button type="button" onClick={onLogout} className="w-full flex items-center gap-2 text-sm text-gray-200 p-2 rounded-md hover:bg-emerald-900"><FiLogOut /> Logout</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <section className={`mx-auto w-full max-w-[900px] px-4 py-14 flex-1 ${conversationStarted ? "" : ""}`}>
        {!conversationStarted && (
          <div className="text-center transition-all">
            <h1 className="m-0 mb-4 text-[var(--secondary-contrast)] text-3xl md:text-5xl leading-tight font-extrabold tracking-tight">Hey{firstName ? ` ${firstName}` : ""}, how can we help today?</h1>
            <p className="text-[var(--secondary-contrast)] max-w-[750px] mx-auto mb-3"><strong>I'm Roadie Ranger</strong> — your quick-answer sidekick on the floor.</p>
            <p className="text-[var(--secondary-contrast)] max-w-[750px] mx-auto mb-4">Ask me anything you need help with, from HR and payroll to restaurant operations and day-to-day tasks. I'll get you clear, trusted guidance in seconds.</p>
            <div className="mt-6 text-[var(--primary-bg)] font-extrabold text-sm">Need help right now? I'm just a tap away.</div>
          </div>
        )}

        <div className="flex flex-col gap-4 max-h-[calc(100vh-400px)] overflow-y-auto p-2" role="log" aria-live="polite">
          {messages.map((item) => <MessageBubble key={item.id} item={item} />)}
          {loading && <TypingIndicator />}
          <div ref={messagesEndRef} />
        </div>
        <div style={{ width: "100%", display: "flex", justifyContent: "center", padding: "10px 16px" }}>
            <div style={{ display: "flex", gap:"12px"}}>
              <button
                type="button"
                onClick={() => {
                  if (mode === null) return setMode("text");
                  if (mode === "text") return; // no change
                  // trying to switch from voice->text or text->voice
                  setShowModeWarning(true);
                }}
                style={{
                  backgroundColor: mode === "text" ? "var(--primary-default)" : "var(--white-100)",
                  color: mode === "text" ? "var(--primary-contrast)" : "var(--text-muted)",
                  padding: "10px 18px",
                  borderRadius: 8,
                  fontWeight: 700,
                  cursor: "pointer",
                  border: mode === "text" ? "none" : "1px solid var(--neutral-300)",
                }}
              >
                Text Mode
              </button>

              <button
                type="button"
                onClick={() => {
                  if (mode === null) return setMode("voice");
                  if (mode === "voice") return;
                  setShowModeWarning(true);
                }}
                style={{
                  backgroundColor: mode === "voice" ? "var(--danger-default)" : "var(--white-100)",
                  color: mode === "voice" ? "var(--danger-contrast)" : "var(--text-muted)",
                  padding: "10px 18px",
                  borderRadius: 8,
                  fontWeight: 700,
                  cursor: "pointer",
                  border: mode === "voice" ? "none" : "1px solid var(--neutral-300)",
                }}
              >
                Voice Mode
              </button>
            </div>
            {/* <div
              style={{
                display: "inline-flex",
                position: "relative",
                padding: 4,
                borderRadius: 999,
                backgroundColor: "var(--neutral-100)",
                border: "1px solid var(--neutral-300)",
                width: 260,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 4,
                  bottom: 4,
                  left: mode === "voice" ? "50%" : 4,
                  width: "calc(50% - 4px)",
                  borderRadius: 999,
                  backgroundColor:
                    mode === "voice" ? "var(--danger-default)" : "var(--primary-default)",
                  transition: "left 0.2s ease, background-color 0.2s ease",
                }}
              />

              <button
                type="button"
                onClick={() => {
                  if (mode === null) return setMode("text");
                  if (mode === "text") return; // no change
                  setShowModeWarning(true);
                }}
                style={{
                  position: "relative",
                  zIndex: 1,
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: 999,
                  fontWeight: 700,
                  cursor: "pointer",
                  color: mode === "text" ? "var(--primary-contrast)" : "var(--text-muted)",
                  transition: "color 0.2s ease",
                }}
              >
                Text Mode
              </button>

              <button
                type="button"
                onClick={() => {
                  if (mode === null) return setMode("voice");
                  if (mode === "voice") return;
                  setShowModeWarning(true);
                }}
                style={{
                  position: "relative",
                  zIndex: 1,
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: 999,
                  fontWeight: 700,
                  cursor: "pointer",
                  color: mode === "voice" ? "var(--danger-contrast)" : "var(--text-muted)",
                  transition: "color 0.2s ease",
                }}
              >
                Voice Mode
              </button>
            </div> */}
          </div>
        <section className="bg-[var(--primary-contrast)] border border-[#1c362d] rounded-xl p-4 shadow-xl w-full">
          {/* Mode selector always on top of input */}
          

          <div className="flex items-start gap-3">
            <div className="bg-[var(--maroon-primary)] border-white h-9 w-9 flex items-center justify-center rounded-full text-lg pt-1">🤠</div>

            {/* Text input only when text mode selected */}
            {mode === "text" && (
              <textarea
                ref={textareaRef}
                className="flex-1 min-h-11 max-h-[150px] overflow-y-auto resize-none rounded-md bg-transparent text-[var(--secondary-contrast)] px-4 py-2 placeholder:text-[var(--text-muted)] focus:outline-none"
                value={draft}
                maxLength={MAX_MESSAGE_LENGTH}
                rows={1}
                disabled={isVoiceActive}
                placeholder={inputPlaceholder}
                onChange={(event) => {
                  const textarea = event.target;
                  textarea.style.height = "auto";
                  textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
                  setDraft(textarea.value.slice(0, MAX_MESSAGE_LENGTH));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
            )}

            {/* If no mode selected, show placeholder input disabled to match layout */}
            {mode === null && (
              <textarea
                className="flex-1 min-h-11 max-h-[150px] overflow-y-auto resize-none rounded-md bg-transparent text-[var(--secondary-contrast)] px-4 py-2 placeholder:text-[var(--text-muted)] focus:outline-none"
                value={draft}
                maxLength={MAX_MESSAGE_LENGTH}
                rows={1}
                disabled
                placeholder={"Select Text or Voice mode above to continue"}
              />
            )}

            {/* If voice mode selected, hide textarea entirely (no input) */}
              {/* If voice mode selected, show disabled placeholder instructing user to create a new chat */}
              {mode === "voice" && (
                <textarea
                  className="flex-1 h-11 rounded-md bg-transparent text-[var(--secondary-contrast)] px-4 py-2 placeholder:text-[var(--text-muted)] focus:outline-none opacity-80"
                  value={""}
                  maxLength={MAX_MESSAGE_LENGTH}
                  rows={1}
                  disabled
                  placeholder={"Coming soon — please create a new chat and choose Text mode to continue"}
                />
              )}
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-emerald-900 pt-3 mt-3">
            <div className="text-xs text-[var(--text-muted)] flex items-center gap-2">
              Press <span className="border border-emerald-800 rounded px-2 py-0.5 text-[var(--text-muted)]">Enter ↵</span> to submit or tap mic to speak
              <small className="text-[var(--text-muted)] ml-2">{draft.length}/{MAX_MESSAGE_LENGTH}</small>
            </div>
            <div className="flex items-center gap-2">
              {/* Controls: show mic only for voice mode, send only for text mode */}
              {mode === "voice" && (
                <button
                  type="button"
                  title="Coming soon"
                  style={{ boxShadow: isVoiceActive ? `0 0 ${8 + micLevel * 18}px rgba(255,183,3,.55)` : "none" }}
                  onClick={() => (isVoiceActive ? stopVoiceSession() : startVoiceSession())}
                  aria-label={isVoiceActive ? "Stop voice" : "Start voice"}
                  className={`w-9 h-9 rounded-full grid place-items-center cursor-pointer border border-emerald-800 ${isVoiceActive ? 'bg-red-600 text-white' : 'bg-[#102a20] text-gray-200'}`}
                >
                  {isVoiceActive ? <FiSquare /> : <FiMic />}
                </button>
              )}

              {mode === "text" && (
                <button
                  type="button"
                  disabled={!draft.trim() || loading || isVoiceActive}
                  onClick={submit}
                  className={`w-9 h-9 rounded-full grid place-items-center ${!draft.trim() || loading || isVoiceActive ? 'bg-[var(--success-default)] text-[--success-contrast] border-emerald-900 cursor-not-allowed' : 'bg-[var(--primary-bg)] text-black border-yellow-400'}`}
                >
                  <FiSend />
                </button>
              )}

              {/* Allow changing mode on landing after a selection */}
              {/* removed Change Mode button per layout request */}
            </div>
          </div>
          {/* Mode switch warning popup */}
          <WarningPopUp isOpen={showModeWarning} onClose={() => setShowModeWarning(false)} message={"To switch agents you must create a new chat session. Click 'New Chat' in the header to start a fresh session."} />
        </section>

        {!conversationStarted && (
          <section className="mt-7">
            <div className="text-xs font-extrabold text-[var(--success-default)] tracking-wider mb-3">POPULAR ROADIE INQUIRIES:</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {QUICK_INQUIRIES.map((inquiry) => (
                <button key={inquiry.text} type="button" onClick={() => populateQuery(inquiry.text)} className="bg-[var(--primary-contrast)] border border-[var(--primary-default)] rounded-xl p-4 text-left text-white cursor-pointer transition">
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
      <footer className="text-center py-4 text-[var(--text-body)] text-xs border-t border-emerald-900">Texas Roadhouse • Roadie Ranger employee support</footer>
    </main>
  );
}

const LandingPage = () => {
  const [userInfo, setUserInfo] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [chatKey, setChatKey] = useState(0);

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
    } finally {
      setChatKey((value) => value + 1);
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

  return <ChatExperience key={`${chatKey}-${sessionId}`} firstName={firstName} sessionId={sessionId} onNewChat={handleNewChat} onLogout={handleLogout} />;
};

export default LandingPage;
