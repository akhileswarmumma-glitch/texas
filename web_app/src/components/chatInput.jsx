import { useCallback, useEffect, useRef, useState } from "react";
import useTextAgent from "./aiTextResponse";
import useVoiceAgent from "./aiVoiceResponse";

const ChartInput = ({ messages = [], sessionId, onSendMessage, loading, setLoading, handleNewChat, setShowWarning, handleLogout}) => {
    const [message, setMessage] = useState("");
    const [isTextActive, setIsTextActive] = useState(false)
    const [mode, setMode] = useState(null); // null = not selected, 'text' or 'voice'

    const wasVoiceActive = useRef(false)

    const handleAgentMessage = useCallback((reply, sender = "ai", options = {}) => {
        onSendMessage(reply, sender, options);
    }, [onSendMessage]);

    // Initialize the useTextAgent hook
    const { sendMessage: sendTextMessage, status: textStatus } = useTextAgent(
        handleAgentMessage,
        setLoading,
        handleLogout
    );
    
    // const handleTextResponse = async (trimmedMessage) =>{
    //     setLoading(true)
    //     console.log("log is --==>",{"user_query": trimmedMessage,
    //             "conversation_id": sessionId,})
    //     const lastAi = [...messages].reverse().find((m) => m.sender === "ai" && m.message_id);
    //     const previous_response_id = lastAi ? lastAi.message_id : "";
    //     try{
    //         const resp = await fetch("https://txrh-app-roadierangerdev-6279-stosup-phmo.azurewebsites.net/api/chat",{
    //             method: "POST",
    //             credentials: "include",
    //             headers: {
    //                 "Content-Type": "application/json",
    //             },
    //             body: JSON.stringify({
    //                 user_message: trimmedMessage,
    //                 conversation_id: sessionId,
    //                 previous_response_id
    //             }),
    //         })
    //         console.log("resp status ios =--=>",resp.status)
    //         if (resp.status === 401) {
    //             await handleLogout();
    //             return;
    //         }
    //         if (!resp.ok){
    //             throw new Error(`HTTP Error: ${resp.status}`);
    //         }

    //         const resp_data = await resp.json()
    //         console.log("resp data is ==>",resp_data)
    //         onSendMessage(resp_data.agent_response, "ai", { message_id: resp_data.response_id, link: resp_data.link, resources: [] })
    //     }catch(error){
    //         console.error(error);
    //         onSendMessage(`⚠️ **Something went wrong while contacting the agent.** Please try again later.`, "ai", { message_id: previous_response_id, link: "", resources: [] }
    //         )
    //     }finally{
    //         setLoading(false)
    //     }  
    // }

    const { isVoiceActive, startVoiceSession, micLevel, status } = useVoiceAgent(
        handleAgentMessage,
        setLoading
    );

    useEffect(() => {
        if (wasVoiceActive.current && !isVoiceActive) {
            handleNewChat();
        }

        wasVoiceActive.current = isVoiceActive;
    }, [isVoiceActive]);

    const handlesend = async () => {
        setIsTextActive(true)
        const trimmedMessage = message.trim();

        if (!trimmedMessage) {
            return;
        }

        onSendMessage(trimmedMessage, "user");
        sendTextMessage(trimmedMessage);
        // handleTextResponse(trimmedMessage)
        setMessage("");
    };

    
    const containerStyle = { position: 'absolute', bottom: 0, left: 0, right: 0, width: '100%', zIndex: 10 }
    
    const handleInputClick = () => {
        if (isVoiceActive) {
            setShowWarning(true);
        }
    };

    return (
        <div className="flex w-full items-center justify-center bg-white border-t border-[var(--neutral-300)]" style={containerStyle}>
            {/* Initial selection: show prominent buttons when no mode selected */}
            {mode === null ? (
                <div className="w-full px-6 py-4 flex items-center justify-center">
                    <div className="flex items-center justify-center gap-4">
                        <button
                            onClick={() => setMode("text")}
                            className="px-5 py-3 rounded-lg text-lg font-semibold shadow-md"
                            style={{
                                backgroundColor: 'var(--primary-default)',
                                color: 'var(--primary-contrast)'
                            }}
                        >
                            Text Mode
                        </button>

                        <button
                            onClick={() => setMode("voice")}
                            className="px-5 py-3 rounded-lg text-lg font-semibold shadow-md"
                            style={{
                                backgroundColor: 'var(--danger-default)',
                                color: 'var(--danger-contrast)'
                            }}
                        >
                            Voice Mode
                        </button>
                    </div>
                </div>
            ) : (
                <div className="w-full px-4 py-3 flex items-center gap-3">
                    {/* Compact mode indicator + change control */}
                    <div className="flex items-center gap-2">
                        <div className="text-sm px-3 py-1 rounded-full" style={{
                            backgroundColor: mode === "text" ? 'var(--primary-default)' : 'var(--danger-default)',
                            color: 'var(--white-100)'
                        }}>
                            {mode === "text" ? 'Text' : 'Voice'}
                        </div>
                    </div>

                    {/* Text mode UI */}
                    {mode === "text" && (
                        <>
                            <input
                                readOnly={isVoiceActive}
                                className={`flex-1 h-11 rounded-full bg-white text-black px-5 text-sm border-[1.5px] border-[var(--neutral-300)] outline-none transition-all duration-200 focus:border-[var(--primary-light)] ${
                                    isVoiceActive ? "bg-gray-100 cursor-pointer" : ""
                                }`}
                                type="text"
                                placeholder={isVoiceActive ? `Voice active (${status})... stop voice call or create new chat to switch mode` : "Type here to start text mode..."}
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        if (loading || isVoiceActive) return; // prevent sending while agent is processing or voice active
                                        handlesend();
                                    }
                                }}
                            />

                            <button
                                title={isVoiceActive ? "stop voice call or create new chat to access text agent" : loading ? "Waiting for agent response..." : "Start text chat"}
                                disabled={isVoiceActive || loading}
                                className="flex h-10 w-10 rounded-full cursor-pointer items-center justify-center text-lg disabled:cursor-not-allowed"
                                onClick={handlesend}
                                style={{
                                    backgroundColor: 'var(--primary-light)',
                                    color: 'var(--primary-contrast)'
                                }}
                            >
                                ➤
                            </button>
                        </>
                    )}

                    {/* Voice mode UI */}
                    {mode === "voice" && (
                        <button
                            title={isTextActive? "create new chat to access voice call" : isVoiceActive ? "Stop Voice Call" : "Start Voice Call"}
                            onClick={startVoiceSession}
                            style={{
                                boxShadow: isVoiceActive ? `0 0 ${8 + micLevel * 12}px var(--danger-default)` : 'none',
                                backgroundColor: isVoiceActive ? 'var(--danger-default)' : 'var(--secondary-default)',
                                color: isVoiceActive ? 'var(--danger-contrast)' : 'var(--text-muted)'
                            }}
                            className={`flex h-10 w-10 rounded-full cursor-pointer items-center justify-center text-lg transition-all duration-200 ${
                                isVoiceActive ? "animate-pulse" : ""
                            }`}
                        >
                            {isVoiceActive ? "⏹️" :  "🎙️"}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default ChartInput;