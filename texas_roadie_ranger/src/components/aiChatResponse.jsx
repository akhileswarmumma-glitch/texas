const AiChatResponse = ({message}) =>{
    return(
        <>
            <div className="flex w-full">
                <div className="flex h-[32px] w-[32px] border items-center justify-center rounded-[50%] mr-2.5 bg-[#004B2B] text-sm text-[#FFC72C]">
                    AI
                </div>
                <div className="flex max-w-[80%] border rounded-[4px_14px_14px_14px] p-2.5 pl-4 pr-4 mt-[1%] bg-[#FFFFFF] border-[#F4EFE6] text-[#2D251E] text-[13px]">
                    {message}
                </div>
            </div>
        </>
    )
}


export default AiChatResponse