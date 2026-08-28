import './markdown.css'
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const AiChatResponse = ({ item }) => {
    const [showConsent, setShowConsent] = useState(true);
    const [showResources, setShowResources] = useState(false);

    const isConsentNeeded = (() => {
        const text = (item && item.message) || "";
        const link = item && item.link;
        return (text && text.toLowerCase().includes("please authorize access to your ServiceNow account. Once completed, return here and resubmit your query".toLowerCase())) || (link && link.length > 0);
    })();
    const resources =
        item?.resources?.length > 0
        ? item.resources
        : [
            // {
            // name: "Employee Handbook",
            // url: "https://contoso.sharepoint.com/",
            // },
    ];

    const handleGrant = () => {
        const link = item && item.link;
        if (link) {
            window.open(link, "_blank", "noopener,noreferrer");
        }
        setShowConsent(false);
    };

    const handleCancel = () => {
        setShowConsent(false);
    };

    return (
        <>
            <div className="flex w-full">
                {/* <div className="flex h-[32px] w-[32px] border items-center justify-center rounded-[50%] mr-2.5 bg-[#004B2B] text-sm text-[#FFC72C]">
                    RR
                </div> */}
                <div className="flex text-[16px] h-[34px] w-[34px] rounded-[50%] bg-[var(--tertiary-default)] items-center justify-center">🤠</div>
                <div className="flex flex-col max-w-[80%] border rounded-[4px_14px_14px_14px] p-2.5 pl-4 pr-4 mt-[1%] bg-[#FFFFFF] border-[#F4EFE6] text-[#2D251E] text-[13px]">
                    <div className="chat-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{item?.message}</ReactMarkdown>
                    </div>
                    
                    {resources.length > 0 && (
                        <div className="mt-3 border-t border-[#E0E0E0] pt-3">
                            <button
                                onClick={() => setShowResources(!showResources)}
                                className="flex items-center gap-2 w-full text-left cursor-pointer hover:opacity-80"
                            >
                                <span className="text-[13px] font-semibold text-[var(--primary-default)]">
                                    🔗 {resources.length} Sources Used
                                </span>
                                <span className="ml-auto text-[12px]">
                                    {showResources ? "▲" : "▼"}
                                </span>
                            </button>
                            
                            {showResources && (
                                <div className="mt-2 space-y-2">
                                    {resources.map((resource, idx) => (
                                        <div key={idx} className="flex items-center gap-3 p-2 bg-[#FAFAFA] rounded-[8px] border border-[#E0E0E0]">
                                            <div className="flex-shrink-0 w-8 h-8 bg-[#E0E0E0] rounded flex items-center justify-center text-[12px]">
                                                📄
                                            </div>
                                            <a
                                                href={resource.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[12px] font-medium text-[#2D251E] truncate hover:text-blue-600 hover:underline"
                                            >
                                                {resource.name}
                                            </a>
                                            {/* <div className="flex-1 min-w-0">
                                                <div className="text-[12px] font-medium text-[#2D251E] truncate">
                                                    {resource}
                                                </div>
                                            </div> */}
                                            {/* <button className="flex-shrink-0 text-[14px] cursor-pointer hover:opacity-75">
                                                ✎
                                            </button> */}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    
                    {isConsentNeeded && showConsent && (
                        <div className="mt-3 flex gap-3">
                            <button
                                onClick={handleGrant}
                                className="px-3 py-1 rounded-[8px] bg-[var(--primary-default)] text-[var(--primary-contrast)] cursor-pointer"
                            >
                                Grant Consent
                            </button>
                            <button
                                onClick={handleCancel}
                                className="px-3 py-1 rounded-[8px] bg-[var(--secondary-default)] border-[var(--neutral-300)] text-[var(--secondary-contrast)] cursor-pointer"
                            >
                                Cancel
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
};


export default AiChatResponse