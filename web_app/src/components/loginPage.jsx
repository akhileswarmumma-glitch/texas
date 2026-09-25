import TexasLogo from "../assets/texas-logo.png"

const LoginPage = () => {

    const handleLogin = () => {
        const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
        window.location.href = `${apiBase || ''}/login`;
    };


    return (
        <>
        <div className="flex w-full h-screen">
            <div
            className="hidden flex p-[5%] lg:flex flex-[1] flex-col text-white"
            style={{
                background:`linear-gradient(var(--success-tint), rgba(0,0,0,0.75)),url('${import.meta.env.VITE_DEFAULT_BG_IMAGE || "https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1200"}')`,
                backgroundSize: "cover",
                backgroundPosition: "center"
            }}
            >
            <div className="flex h-[60px] font-extrabold">
                <img src={TexasLogo} alt="" />
            </div>

            <div className="mt-[10%]  tracking-tight">
                <h1 className="font-black text-4xl mb-5">
                    Your Home for Support & Answers.
                </h1>
                <p className="mt-5 text-[var(--neutral-200)] max-w-[500px] text-xl leading-8">
                    Sign in and connect with Roadie Ranger to get help you need across HR, payroll, IT, and more, all in one place.
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
