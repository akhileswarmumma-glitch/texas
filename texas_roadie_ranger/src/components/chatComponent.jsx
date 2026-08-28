import { useState } from "react";
import HomeScreen from "./homeScreen";

const ChartComponent = ({ messages, setMessages, sessionId, handleNewChat,loading,setLoading }) => {

    const handleSendMessage = (message, sender = "user", options = {}) => {
        const { streaming = false } = options;

        if (sender === "ai") {
            setMessages((prevMessages) => {
                let lastAiMessageIndex = -1;

                for (let i = prevMessages.length - 1; i >= 0; i -= 1) {
                    if (prevMessages[i].sender === "ai" && prevMessages[i].streaming) {
                        lastAiMessageIndex = i;
                        break;
                    }
                }

                if (streaming) {
                    if (lastAiMessageIndex >= 0) {
                        return prevMessages.map((item, index) =>
                            index === lastAiMessageIndex
                                ? { ...item, message: item.message + message }
                                : item
                        );
                    }

                    return [
                        ...prevMessages,
                        {
                            id: Date.now(),
                            message,
                            sender,
                            streaming: true,
                        },
                    ];
                }

                if (lastAiMessageIndex >= 0) {
                    return prevMessages.map((item, index) =>
                        index === lastAiMessageIndex
                            ? { ...item, message, streaming: false }
                            : item
                    );
                }

                return [
                    ...prevMessages,
                    {
                        id: Date.now(),
                        message,
                        sender,
                    },
                ];
            });
            return;
        }

        setMessages((prevMessages) => [
            ...prevMessages,
            {
                id: Date.now(),
                message,
                sender,
            },
        ]);
    };
    return (
        <div>
            <HomeScreen
                messages={messages}
                onSendMessage={handleSendMessage}
                sessionId={sessionId}
                loading={loading}
                setLoading={setLoading}
                handleNewChat={handleNewChat}
            />
        </div>
    );
};

export default ChartComponent;