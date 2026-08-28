import { useState } from "react";
import HomeScreen from "./homeScreen";

const ChartComponent = ({ messages, setMessages, sessionId, handleNewChat,loading,setLoading, handleLogout }) => {

    const handleSendMessage = (message, sender = "user", meta = {}) => {
        // meta can be either an options object (e.g. { streaming: true })
        // or a string message_id. Normalize to an object.
        let options = {};
        let message_id = "";
        let link = "";
        let resources = [];

        if (typeof meta === "string") {
            message_id = meta;
        } else if (meta && typeof meta === "object") {
            options = meta;
            if (typeof meta.message_id === "string") {
                message_id = meta.message_id;
            }
            if (typeof meta.link === "string") {
                link = meta.link;
            }
            if (Array.isArray(meta.resources)) {
                resources = meta.resources;
            }
        }

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
                            message_id,
                            link,
                            resources
                        },
                    ];
                }

                if (lastAiMessageIndex >= 0) {
                    return prevMessages.map((item, index) =>
                        index === lastAiMessageIndex
                            ? { ...item, message, streaming: false, message_id: message_id || item.message_id, link: link || item.link, resources: resources.length > 0 ? resources : item.resources }
                            : item
                    );
                }

                return [
                    ...prevMessages,
                    {
                        id: Date.now(),
                        message,
                        sender,
                        message_id,
                        link,
                        resources
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
                message_id: "",
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
                handleLogout={handleLogout}
            />
        </div>
    );
};

export default ChartComponent;