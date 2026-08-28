import { useState, useEffect, useRef } from "react";
import "../App.css";
import ChartComponent from "./chatComponent.jsx";
import LoginPage from "./loginPage.jsx";
import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import Dashboard from "./dashboard.jsx";
import WarningPopUp from "./warningPopUp.jsx";

const Chat = ({handleLogout}) => {
  const { instance, accounts } = useMsal();

  const isAuthenticated = useIsAuthenticated();
  const [showChat, setShowChat] = useState(false);
  const [panelW, setPanelW] = useState(430);
  const [panelH, setPanelH] = useState(550);
  const resizingRef = useRef(false);
  const resizeModeRef = useRef("both");
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startWRef = useRef(0);
  const startHRef = useRef(0);
  const [isMaximized, setIsMaximized] = useState(false);
  const [loading, setLoading] = useState(false);

  const startResize = (e, mode) => {
    if (isMaximized) return;
    e.preventDefault();
    resizingRef.current = true;
    resizeModeRef.current = mode || "both";
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    startWRef.current = panelW;
    startHRef.current = panelH;
    window.getSelection().removeAllRanges();
  };

  useEffect(() => {
    function onMouseMove(e) {
      if (!resizingRef.current) return;
      const dx = e.clientX - startXRef.current;
      const dy = e.clientY - startYRef.current;
      let newW = startWRef.current - dx;
      let newH = startHRef.current - dy;
      const maxW = window.innerWidth - 56;
      const maxH = window.innerHeight - 56;
      if (resizeModeRef.current === "width") {
        if (newW < 320) newW = 320;
        if (newW > maxW) newW = maxW;
        setPanelW(newW);
        return;
      }
      if (resizeModeRef.current === "height") {
        if (newH < 380) newH = 380;
        if (newH > maxH) newH = maxH;
        setPanelH(newH);
        return;
      }
      if (newW < 320) newW = 320;
      if (newW > maxW) newW = maxW;
      if (newH < 380) newH = 380;
      if (newH > maxH) newH = maxH;
      setPanelW(newW);
      setPanelH(newH);
    }

    function onMouseUp() {
      resizingRef.current = false;
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [panelW, panelH]);

  useEffect(() => {
    // Keep MSAL's active account context synchronized when authenticated
    if (accounts.length > 0 && !instance.getActiveAccount()) {
      instance.setActiveAccount(accounts[0]);
    }
  }, [accounts, instance]);

  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState("");  

  const handleNewChat = async () => {
    try {
      console.log("====================handle chat triggred====================")
      const response = await fetch(
        "https://txrh-app-roadierangerdev-6279-stosup-phmo.azurewebsites.net/api/get_conversation_id",
        {
          method: "GET",
          credentials: "include",
        }
      );
      console.log("status is -=>",response.status)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      console.log("data is --==>",data)

      console.log("Conversation ID:", data.conversation_id);

      setSessionId(data.conversation_id);

    } catch (error) {
      console.error("Failed to start new chat session:", error);
    }
    setLoading(false)
    setMessages([]);
  };
  const panelStyle = isMaximized
    ? {
      position: "fixed",
      top: 0,
      left: 0,
      width: "100vw",
      height: "100vh",
      zIndex: 9999, // High z-index to guarantee full-screen coverage
      borderRadius: 0,
      background: "#FFFFFF",
      display: "flex",
      flexDirection: "column",
    }
    : {
      position: "fixed",
      bottom: 28,
      right: 28,
      width: `${panelW}px`,
      height: `${panelH}px`,
      minWidth: 320,
      minHeight: 380,
      zIndex: 2001,
      borderRadius: 16,
      overflow: "hidden",
      boxShadow: "0 16px 48px rgba(26,18,11,0.25)",
      background: "#FFFFFF",
      border: "1px solid #F4EFE6",
      display: "flex",
      flexDirection: "column",
    };
  return (
    <div>
      {/* Floating chat launcher (wireframe look) */}
      {!showChat && (
        <div
          id="chat-launcher"
          onClick={() => {
            if (!sessionId) {
              handleNewChat();
            }
            setShowChat(true);
          }}
          className="fixed bottom-[28px] right-[28px] w-16 h-16 rounded-full bg-[var(--success-default)] shadow-[0_8px_24px_rgba(0,75,43,0.35)] flex items-center justify-center cursor-pointer border-2 border-[var(--tertiary-default)] text-white text-[26px]"
        >
          💬
        </div>
      )}

      {/* Render ChartComponent as a fixed panel when chat is opened */}
      {showChat && (
        <div style={panelStyle}>
          {/* Resize handles */}
          <div
            onMouseDown={(e) => startResize(e, "both")}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: 22,
              height: 22,
              cursor: "nwse-resize",
              zIndex: 2002,
            }}
          />
          <div
            onMouseDown={(e) => startResize(e, "width")}
            style={{
              position: "absolute",
              top: 22,
              left: 0,
              width: 6,
              height: "calc(100% - 22px)",
              cursor: "ew-resize",
              zIndex: 2002,
            }}
          />
          <div
            onMouseDown={(e) => startResize(e, "height")}
            style={{
              position: "absolute",
              top: 0,
              left: 22,
              width: "calc(100% - 22px)",
              height: 6,
              cursor: "ns-resize",
              zIndex: 2002,
            }}
          />

          <div className="flex p-4.5 flex-row justify-between bg-[var(--primary-light)]">
            <div className="flex gap-[8px]">
              <div className="flex text-[16px] h-[34px] w-[34px] rounded-[50%] bg-[var(--tertiary-default)] items-center justify-center">🤠</div>
              <div>
                <div className="font-[700] text-[14px] text-[var(--primary-contrast)]">Roadie Ranger</div>
                <div className="text-[12px] text-[#C9DBF6]">● Online now</div>
              </div>
            </div>
            <div className="flex items-center gap-[8px]">
              <button
                className="flex items-center border p-1.5 rounded-[9999px] bg-[var(--tertiary-tint)] text-[var(--secondary-default)] text-xs flex gap-[5px] cursor-pointer border-[#FDFBF7] transition-all duration-200 hover:border-[#FFC72C]"
                onClick={handleNewChat}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="1 4 1 10 7 10"></polyline>
                  <path d="M3.51 15a9 9 0 1 0 .49-3.5"></path>
                </svg>
                New Chat
              </button>
              <button
                title={isMaximized ? "Restore size" : "Maximize chat"}
                className="p-1 flex items-center justify-center cursor-pointer transition-opacity duration-200 hover:opacity-75"
                onClick={() => setIsMaximized(!isMaximized)}
              >
                {isMaximized ? (
                  /* Restore icon */
                  <span className="text-[white] text-[17px]">❐</span>

                ) : (
                  /* Maximize icon */
                  <span className="text-[white] text-[17px]">⛶</span>
                )}
              </button>
              <button
                onClick={() => {
                  (setShowChat(false), handleNewChat());
                }}
                className="cursor-pointer font-[950] text-sm text-[var(--primary-contrast)] mr-[18px] h-[26px] w-[26px] bg-[rgba(255,255,255,0.15)] rounded-[50%]"
              >
                ✕
              </button>
            </div>

          </div>
          <div
            style={{
              flex: "1 1 auto",
              overflow: "auto",
              background: "#FDFBF7",
            }}
          >
            <ChartComponent
              messages={messages}
              setMessages={setMessages}
              sessionId={sessionId}
              handleNewChat={handleNewChat}
              loading={loading}
              setLoading={setLoading}
              handleLogout={handleLogout}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default Chat;
