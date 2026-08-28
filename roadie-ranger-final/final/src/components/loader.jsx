const Loader = () =>{
    return (
        <>
            <div className="flex w-full">
                {/* <div className="flex h-[32px] w-[32px] border items-center justify-center rounded-[50%] mr-2.5 bg-[#004B2B] text-sm text-[#FFC72C]">
                    RR
                </div> */}
                <div className="flex text-[16px] h-[34px] w-[34px] rounded-[50%] bg-[var(--tertiary-default)] items-center justify-center">🤠</div>
                <div className='flex flex-col border border-[#004B2B] gap-[10px] max-w-[80%] ml-[10px] mt-[1%] p-2.5 rounded-[4px_14px_14px_14px]'>
                    <div className='flex flex-col gap-[4px]'>
                        <span className='text-xs text-[oklch(0.60 0.04 256)] flex flex-col'>Processing</span>
                        <div style={{display: "flex", gap: "8px"}}>
                            <div className=' w-[15px] h-[15px] border-[2px] border-[oklch(0.46935_0.1718_257.748)] border-t-transparent rounded-full animate-spin text-[oklch(0.33002_0.11412_256.342)] text-[14px] shrink-0 font-xs'></div>
                        </div> 
                    </div> 
                    {/* <div className="border-t border-t-[oklch(0.93_0.02_256)]">
                        <div className="mt-[10px] px-[12px] py-[10px] border border-dashed border-[oklch(0.75_0.06_241)] bg-[oklch(93.608%_0.01958_252.986)] text-[13px] rounded-[6px] text-center text-[oklch(0.75_0.06_241)]">
                            Response appears &amp; card expands here ↓
                        </div>
                    </div> */}
                </div>
            </div> 
        </>
    )
}


export default Loader;