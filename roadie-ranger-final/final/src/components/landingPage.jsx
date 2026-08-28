import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaUser } from "react-icons/fa";
import { FiLogOut, FiPlus, FiSend, FiMic, FiSquare, FiChevronDown } from "react-icons/fi";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useTextAgent from "./aiTextResponse.jsx";
import useVoiceAgent from "./aiVoiceResponse.jsx";
import texasLogo from "../assets/texas-logo.png";
import "./roadieRanger.css";

const QUICK_INQUIRIES = [
  { category: "HR & Benefits", text: "How do I enroll in or update my benefits?" },
  { category: "HR & Payroll", text: "How do I update my W-4 or tax withholding forms?" },
  { category: "POS & Billing", text: "How do I replace or redeem a damaged gift card?" },
  { category: "Finance & Ops", text: "How do I contact travel, expense or vendor support?" },
];

const MAX_MESSAGE_LENGTH = 2000;

function AgentAvatar() {
  return <div className="roadie-avatar">🤠</div>;
}

function MessageBubble({ item }) {
  const [showResources, setShowResources] = useState(false);
  const [showConsent, setShowConsent] = useState(true);
  const resources = item.resources || [];
  const needsConsent = Boolean(item.link) || Boolean(item.consentRequired);

  return (
    <div className={`roadie-message-row ${item.sender === "user" ? "user" : "agent"}`}>
      {item.sender !== "user" && <AgentAvatar />}
      <div className={`roadie-message ${item.sender === "user" ? "user-message" : "agent-message"}`}>
        {item.sender !== "user" && <div className="roadie-agent-label">✦ Roadie Ranger</div>}
        <div className="roadie-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message}</ReactMarkdown>
        </div>

        {resources.length > 0 && (
          <div className="roadie-resources">
            <button type="button" onClick={() => setShowResources((value) => !value)}>
              <span>🔗 {resources.length} Sources Used</span>
              <FiChevronDown className={showResources ? "rotated" : ""} />
            </button>
            {showResources && (
              <div className="roadie-resource-list">
                {resources.map((resource, index) => (
                  <a key={`${resource.url}-${index}`} href={resource.url} target="_blank" rel="noreferrer">
                    📄 <span>{resource.name || resource.url}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {needsConsent && showConsent && (
          <div className="roadie-consent">
            <button type="button" onClick={() => item.link && window.open(item.link, "_blank", "noopener,noreferrer")}>Grant Consent</button>
            <button type="button" className="secondary" onClick={() => setShowConsent(false)}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="roadie-message-row agent">
      <AgentAvatar />
      <div className="roadie-message agent-message typing-message">
        <div className="roadie-agent-label">✦ Roadie Ranger</div>
        <div className="roadie-dots"><span /><span /><span /></div>
      </div>
    </div>
  );
}

function ChatExperience({ firstName, sessionId, onNewChat, onLogout }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
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
    if (loading || isVoiceActive) return;
    addMessage(text, "user");
    void sendTextMessage(text);
  }, [addMessage, isVoiceActive, loading, sendTextMessage]);

  const conversationStarted = messages.length > 0;
  const inputPlaceholder = isVoiceActive
    ? `Voice active (${voiceStatus})...`
    : "Ask Roadie Ranger anything... (e.g., benefits, W-4, gift cards, POS, travel & expense)";

  return (
    <main className="roadie-page">
      <header className="roadie-header">
        <div className="roadie-brand">
          <div className="roadie-brand-mark">✦</div>
          <div>
            <div className="roadie-brand-title">Roadie Ranger</div>
            <div className="roadie-online"><span /> Online now</div>
          </div>
        </div>

        <div className="roadie-header-actions">
          <button type="button" className="roadie-new-chat" onClick={onNewChat}>
            <FiPlus /> New Chat
          </button>
          <div className="roadie-profile" ref={profileRef}>
            <button type="button" className="roadie-profile-button" onClick={() => setShowProfile((value) => !value)}>
              {firstName ? firstName.slice(0, 2).toUpperCase() : <FaUser />}
            </button>
            {showProfile && (
              <div className="roadie-profile-menu">
                <div className="roadie-profile-name">{firstName || "Roadie"}</div>
                <button type="button" onClick={onLogout}><FiLogOut /> Logout</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <section className={`roadie-content ${conversationStarted ? "conversation-active" : ""}`}>
        {!conversationStarted && (
          <div className="roadie-intro">
            <h1>Hey{firstName ? ` ${firstName}` : ""}, how can we help today?</h1>
            <p><strong>Howdy! I'm Roadie Ranger</strong> — your quick-answer sidekick on the floor.</p>
            <p>Ask me anything you need help with, from HR and payroll to restaurant operations and day-to-day tasks. I'll get you clear, trusted guidance in seconds.</p>
            <div className="roadie-help-now">Need help right now? I'm just a tap away.</div>
          </div>
        )}

        <div className="roadie-chat-stream" role="log" aria-live="polite">
          {messages.map((item) => <MessageBubble key={item.id} item={item} />)}
          {loading && <TypingIndicator />}
          <div ref={messagesEndRef} />
        </div>

        <section className="roadie-input-panel">
          <div className="roadie-input-row">
            <div className="roadie-input-icon">✦</div>
            <textarea
              value={draft}
              maxLength={MAX_MESSAGE_LENGTH}
              rows={1}
              disabled={isVoiceActive}
              placeholder={inputPlaceholder}
              onChange={(event) => setDraft(event.target.value.slice(0, MAX_MESSAGE_LENGTH))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <div className="roadie-input-footer">
            <div className="roadie-hint">
              Press <span>Enter ↵</span> to submit or tap mic to speak
              <small>{draft.length}/{MAX_MESSAGE_LENGTH}</small>
            </div>
            <div className="roadie-controls">
              <button
                type="button"
                className={`roadie-mic ${isVoiceActive ? "active" : ""}`}
                style={{ boxShadow: isVoiceActive ? `0 0 ${8 + micLevel * 18}px rgba(255,183,3,.55)` : "none" }}
                onClick={() => (isVoiceActive ? stopVoiceSession() : startVoiceSession())}
                aria-label={isVoiceActive ? "Stop voice" : "Start voice"}
              >
                {isVoiceActive ? <FiSquare /> : <FiMic />}
              </button>
              <button type="button" className="roadie-send" disabled={!draft.trim() || loading || isVoiceActive} onClick={submit}>
                <FiSend />
              </button>
            </div>
          </div>
        </section>

        {!conversationStarted && (
          <section className="roadie-popular">
            <div className="roadie-section-label">✦ POPULAR ROADIE INQUIRIES:</div>
            <div className="roadie-inquiry-grid">
              {QUICK_INQUIRIES.map((inquiry) => (
                <button key={inquiry.text} type="button" className="roadie-inquiry" onClick={() => selectInquiry(inquiry.text)}>
                  <div className="roadie-inquiry-top">
                    <span>{inquiry.category}</span><b>❯</b>
                  </div>
                  <p>"{inquiry.text}"</p>
                </button>
              ))}
            </div>
          </section>
        )}
      </section>
      <footer className="roadie-footer">Texas Roadhouse • Roadie Ranger employee support</footer>
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
