import { useState } from "react";
import AiChatResponse from "./aiChatResponse";
import ChartInput from "./chatInput";
import Loader from "./loader";
import UserQuestion from "./userQuestion";
import WarningPopUp from "./warningPopUp";

const HomeScreen = ({ messages, onSendMessage, sessionId, loading, setLoading, handleNewChat}) => {
    // const containerClass = `flex flex-col w-full ${compact ? "h-auto" : "h-screen"} bg-[#f9f7f2]`;
    const [showWarning, setShowWarning] = useState(false);
    return (
        <div className="flex flex-col w-full h-auto bg-[#FFFFFF]">
            <div className="flex-1 overflow-y-auto px-4 pb-24 pt-4">
                {messages.length === 0 ? (
                    loading ? null : <div className="flex h-full items-center justify-center text-sm text-gray-500 mt-50">
                        Choose how you'd like to start: Text or Voice. The selected mode will remain active for the entire conversation.
                    </div>
                ) : (
                    messages.map((item) => {
                        return item.sender === "user" ? <UserQuestion key={item.id} message={item.message} /> : <AiChatResponse key={item.id} message={item.message} />
                    })
                    
                )}

                {loading && <Loader />}
                {showWarning &&<WarningPopUp isOpen={true} onClose={()=>{setShowWarning(false)}} message="To switch model in middle create a new session" /> }

            </div>
            <ChartInput sessionId={sessionId} onSend={onSendMessage} setLoading={setLoading} handleNewChat={handleNewChat} setShowWarning={setShowWarning} />
        </div>
    );
};

export default HomeScreen;