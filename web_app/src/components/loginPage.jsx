import { useState } from "react";
import TexasLogo from "../assets/texas-logo.png"

const LoginPage = () => {

    const handleLogin = () => {
        console.log("Login clicked");
        window.location.href =
        "https://txrh-app-roadierangerdev-6279-stosup-phmo.azurewebsites.net/login";
    };


    return (
        <>
        <div className="flex w-full h-screen">
            <div
            className="hidden flex p-[5%] lg:flex flex-[1] flex-col text-white"
            style={{
                background:`linear-gradient(var(--success-tint), rgba(0,0,0,0.75)),url('https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1200')`,
                backgroundSize: "cover",
                backgroundPosition: "center"
            }}
            >
            <div className="flex h-[60px] font-extrabold">
                <img src={TexasLogo} alt="" />
            </div>

            <div className="mt-[10%]  tracking-tight">
                <h1 className="font-black text-4xl mb-5">
                    Your Home for Support,
                    <br />
                    Answers &amp; Growth.
                </h1>
                <p className="mt-5 text-[var(--neutral-200)] max-w-[500px] text-xl leading-8">
                    Sign in to resolve HR &amp; IT queries, chat with Roadie Ranger anytime, and discover new opportunities across Texas Roadhouse.
                </p>
                <div className="text-xs text-white/50 mt-[10%]">
                    &copy; 2026 Texas Roadhouse Core Web Portal. All rights reserved.
                </div>
            </div>
            </div>

            <div className="flex flex-1 bg-[#FDFBF7] items-center justify-center min-w-[340px] rounded-[16px] shadow-[0_10px_30px_rgba(0,0,0,0.06)]">
                <div className="border-0 flex flex-col w-full max-w-[380px] p-[48px_36px] bg-white border border-[#F4EFE6] rounded-2xl  shadow-xl m-[10%] items-center">
                    <div className="flex justify-center items-center h-[64px] w-[64px] rounded-[50%] bg-[rgba(13,71,161,0.08)] text-[28px] m-[0_auto_24px_auto]">🔐</div>
                    <h5 className="text-xl text-[var(--success-tint)]">Welcome Back, Roadie</h5>
                    <p className="pl-[2%] pt-[2%] m-[0px_0px_32px_0px] text-center text-[var(--text-muted)] text-sm leading-6">Sign in with your company account to access the employee support portal.</p>
                    <button onClick={handleLogin} className="w-full h-[50px] bg-[var(--tertiary-shade)] text-[var(--primary-contrast)] text-[15px] font-[700] border-none rounded-[8px] cursor-pointer">Login</button>
                    <p className="text-[var(--text-muted)] mt-[5%] text-[13px] text-center">You'll be securely redirected to sign in via Single Sign-On (SSO).</p>
                </div>
            
            </div>
        </div>
        </>
    );
};

export default LoginPage;



{/* <button className="flex cursor-pointer justify-center mt-[5%] border w-[80%] items-center ml-[10%] p-[3%] rounded-[6px] gap-[5%] border-[#8C8276] bg-white transition-all duration-200 hover:bg-gray-50 hover:border-[#004B2B] hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
                    onClick={handleMicrosoftLogin}
                    >
                        <svg viewBox="0 0 23 23" className="w-5 h-5 shrink-0" aria-hidden="true">
                            <path fill="#f35325" d="M0 0h11v11H0z"/>
                            <path fill="#81bc06" d="M12 0h11v11H12z"/>
                            <path fill="#05a6f0" d="M0 12h11v11H0z"/>
                            <path fill="#ffba08" d="M12 12h11v11H12z"/>
                        </svg>
                        <span className="text-[#2F2F2F] text-sm font-bold text-[#7A7067]">Sign in with Microsoft</span>
                    </button>
                    <div className="text-xs flex justify-center mt-[5%] text-[#7A7067] font-semibold tracking-wider">
                        <span>or use roadhouse account</span>
                    </div>
                    <form action="">
                        <div className="mt-[10%] flex flex-col mb-5 w-full">
                            <div className="ml-[10%] flex flex-col">
                            <label htmlFor="email" className="font-bold text-sm mb-[2.5%]">Email Address</label>
                            <input type="email" required value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="name@company.com" className="border border-[#D5CFC6] p-[2%] w-[80%] rounded-[6px] bg-[#FDFBF7] mb-[2.5%] text-sm text-[#2D251E] outline-none transition-all duration-200 focus:border-[#004B2B] focus:bg-white focus:ring-1 focus:ring-[#004B2B]"/>
                            <label htmlFor="password" className="font-bold text-sm mb-[2.5%]">Password</label>
                            <input type="password" required value={password} onChange={(e)=>setPassword(e.target.value)} placeholder="•••••••••••••" className="border border-[#D5CFC6] p-[2%] w-[80%] rounded-[6px] bg-[#FDFBF7] mb-[4%] text-sm text-[#2D251E] outline-none transition-all duration-200 focus:border-[#004B2B] focus:bg-white focus:ring-1 focus:ring-[#004B2B]"/>
                            <button onClick={(e) => {
                                e.preventDefault();
                                handleManualLogin(userCred)
                            }}

                            className="border w-[80%] bg-[#004B2B] p-[2%] rounded-lg text-white font-bold mb-[4%] cursor-pointer">Sign In</button>
                            </div>
                            
                            <button className="ml-[0%] text-[#004B2B] text-sm font-bold cursor-pointer">Forgot password?</button>
                        </div>
                    </form> */}