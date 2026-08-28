import { useCallback, useEffect, useRef, useState } from "react";
import useTextAgent from "./aiTextResponse";
import useVoiceAgent from "./aiVoiceResponse";

const ChartInput = ({ messages = [], sessionId, onSendMessage, setLoading,handleNewChat, setShowWarning, handleLogout}) => {
    const [message, setMessage] = useState("");
    const [isTextActive, setIsTextActive] = useState(false)

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
        <div className="flex w-full h-[70px] items-center justify-center bg-white border-t border-[#D5CFC6]" style={containerStyle}>
            <div className="w-full px-4 py-3 flex items-center gap-3">
                <input
                    readOnly={isVoiceActive}
                    // onClick={handleInputClick}
                    className={`flex-1 h-11 rounded-full bg-white text-black px-5 text-sm border-[1.5px] border-[#D5CFC6] outline-none transition-all duration-200 focus:border-[#004B2B] ${
                        isVoiceActive ? "bg-gray-100 cursor-pointer" : ""
                    }`}
                    type="text"
                    placeholder={isVoiceActive ? `Voice active (${status})... stop voice call or create new chat to switch mode` : "Type here to start text mode..."}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            handlesend();
                        }
                    }}
                />

                <button
                    title={isTextActive? "create new chat to access voice call" : isVoiceActive ? "Stop Voice Call" : "Start Voice Call"}
                    // onClick={startVoiceSession}
                    disabled
                    style={{
                        boxShadow: isVoiceActive ? `0 0 ${8 + micLevel * 12}px #dc2626` : 'none',
                    }}
                    className={`flex h-10 w-10 rounded-full cursor-pointer items-center justify-center text-lg transition-all duration-200 ${
                        isVoiceActive
                        ? "bg-red-600 text-white animate-pulse"
                        : "bg-[#F4EFE6] text-[#6B6B6B]"
                    }`}
                >
                    {isVoiceActive ? "⏹️" :  "🎙️"}
                </button>

                <button
                    title={isVoiceActive ? "stop voice call or create new chat to access text agent": "Start text chat"}
                    disabled={isVoiceActive}
                    className="flex h-10 w-10 rounded-full bg-[#004B2B] cursor-pointer items-center justify-center text-lg text-[#FFC72C] disabled:bg-[#449774] disabled:cursor-not-allowed"
                    onClick={handlesend}
                >
                    ➤
                </button>
            </div>
        </div>
    );
};

export default ChartInput;