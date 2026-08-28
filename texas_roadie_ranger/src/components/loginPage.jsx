import { useState } from "react";
import { loginRequest } from "../auth/authConfig";
import { useMsal } from "@azure/msal-react";

const LoginPage = () => {
    const { instance } = useMsal();
    const [email,setEmail] = useState("")
    const [password, setPassword] = useState("")

    const userCred = {"email": email, "password": password}

    const handleManualLogin = (data)=>{
        console.log("data is ==>",data)
    }

    const handleMicrosoftLogin = async () => {
        try {
        // const loginResponse = await instance.loginPopup(loginRequest);
        await instance.loginRedirect(loginRequest);
        // console.log("SSO Sign-in success data:", loginResponse);
        } catch (error) {
        console.error("SSO Sign-in error:", error);
        }
    };
    return (
        <>
        <div className="flex w-full h-screen">
            <div
            className="hidden flex p-[8%] lg:flex flex-[1.2] flex-col text-white"
            style={{
                background:`linear-gradient(rgba(0, 75, 43, 0.85), rgba(26, 18, 11, 0.9)),url('https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1200')`,
                backgroundSize: "cover",
                backgroundPosition: "center"
            }}
            >
            <div className="text-[#FFC72C] text-2xl font-extrabold">
                <span>🤠</span> TEXAS ROADHOUSE
            </div>

            <div className="mt-[20%]  tracking-tight">
                <h1 className="font-black text-4xl mb-5">
                Legendary Food,
                <br />
                Legendary Service.
                </h1>
                <div className="mt-5 text-[#F4EFE6]">
                    Manage your orders, customize your corporate catering dashboard, and view details natively synced via secure enterprise integration.
                </div>
                <div className="text-xs text-white/50 mt-[30%]">
                    &copy; 2026 Texas Roadhouse Core Web Portal. All rights reserved.
                </div>
            </div>
            </div>

            <div className="flex flex-1 bg-[#FDFBF7] items-center justify-center">
                <div className="border-0 flex flex-col w-full max-w-[440px] bg-white border border-[#F4EFE6] rounded-2xl  shadow-xl m-[10%]">
                    <h1 className="pl-[5%] pt-[5%] text-2xl font-bold text-[#004B2B]">Welcome Back</h1>
                    <span className="pl-[5%] pt-[3%] text-[#7A7067] text-sm">Sign in to access the portal dashboard.</span>
                    <button className="flex cursor-pointer justify-center mt-[5%] border w-[80%] items-center ml-[10%] p-[3%] rounded-[6px] gap-[5%] border-[#8C8276] bg-white transition-all duration-200 hover:bg-gray-50 hover:border-[#004B2B] hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
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
                    </form>
                </div>
            
            </div>
        </div>
        </>
    );
};

export default LoginPage;
