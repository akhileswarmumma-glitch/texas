import React, { useState } from 'react';
import { useMsal, useIsAuthenticated } from "@azure/msal-react";

// Standard login scope for Microsoft API
const loginRequest = {
  scopes: ["User.Read"]
};

export default function TexasRoadhouseLogin() {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const activeUser = accounts[0];

  // Traditional Form States
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Handlers
  const handleMicrosoftLogin = () => {
    instance.loginRedirect(loginRequest).catch(e => {
      console.error("Microsoft login failed: ", e);
    });
  };

  const handleLogout = () => {
    instance.logoutRedirect();
  };

  const handleStandardLogin = (e) => {
    e.preventDefault();
    alert(`Signing in with traditional user account: ${email}`);
  };

  return (
    <main className="w-full min-h-screen flex bg-[#FDFBF7] text-[#2D251E] selection:bg-[#FFC72C] selection:text-[#1A120B]">
      
      {isAuthenticated && activeUser ? (
        /* --- DASHBOARD VIEW (AFTER SUCCESSFUL SSO) --- */
        <div className="w-full min-h-screen flex flex-col items-center justify-center p-6 text-center">
          <div className="max-w-md w-full bg-white border border-[#F4EFE6] p-8 rounded-2xl shadow-xl">
            <span className="text-5xl mb-4 block">🤠</span>
            <h1 className="text-3xl font-extrabold text-[#004B2B] tracking-tight mb-2">Howdy, Partner!</h1>
            <p className="text-[#7A7067] mb-6">Successfully signed in via Microsoft SSO</p>
            
            <div className="bg-[#F4EFE6] p-4 rounded-lg mb-6 text-left">
              <p className="text-xs text-[#7A7067] font-bold uppercase tracking-wider mb-1">Signed in as</p>
              <p className="text-sm font-bold text-[#2D251E]">{activeUser.name}</p>
              <p className="text-xs text-[#7A7067]">{activeUser.username}</p>
            </div>

            <button 
              onClick={handleLogout}
              className="w-full h-11 bg-[#004B2B] text-white rounded-lg text-sm font-bold tracking-wide transition-all duration-200 hover:bg-[#00361F] active:scale-95"
            >
              Sign Out
            </button>
          </div>
        </div>
      ) : (
        /* --- DUAL PANEL LOGIN PORTAL VIEW --- */
        <>
          {/* Left Panel: Aesthetic Brand Image */}
          <div 
            className="hidden lg:flex flex-[1.2] flex-col justify-between p-16 text-white relative bg-cover bg-center"
            style={{
              backgroundImage: `linear-gradient(rgba(0, 75, 43, 0.85), rgba(26, 18, 11, 0.9)), url('https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1200')`
            }}
          >
            <div className="font-extrabold tracking-widest text-[#FFC72C] flex items-center gap-2.5">
              <span className="text-2xl">🤠</span> TEXAS ROADHOUSE
            </div>

            <div className="max-w-[500px] my-auto">
              <h1 className="text-5xl font-black mb-5 leading-tight tracking-tight">
                Legendary Food,<br />Legendary Service.
              </h1>
              <p className="text-base text-[#F4EFE6] leading-relaxed opacity-95">
                Manage your orders, customize your corporate catering dashboard, and view details natively synced via secure enterprise integration.
              </p>
            </div>

            <div className="text-xs text-white/50 tracking-wide">
              &copy; 2026 Texas Roadhouse Core Web Portal. All rights reserved.
            </div>
          </div>

          {/* Right Panel: Active Login Card */}
          <div className="flex-1 bg-[#FDFBF7] flex justify-center items-center p-8 md:p-16">
            <div className="w-full max-w-[420px] bg-white border border-[#F4EFE6] rounded-2xl p-8 md:p-10 shadow-xl">
              
              {/* Card Header */}
              <div className="mb-8 text-left">
                <h2 className="text-2xl font-extrabold text-[#004B2B] tracking-tight mb-2">Welcome Back</h2>
                <p className="text-sm text-[#7A7067]">Sign in to access the portal dashboard.</p>
              </div>

              {/* Microsoft SSO Button */}
              <button
                type="button"
                onClick={handleMicrosoftLogin}
                className="w-full h-[50px] flex items-center justify-center gap-3.5 bg-white border border-[#8C8276] rounded-lg text-[#2F2F2F] text-sm font-semibold transition-all duration-200 shadow-sm hover:bg-gray-50 hover:border-[#004B2B] hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
              >
                <svg viewBox="0 0 23 23" className="w-5 h-5 shrink-0" aria-hidden="true">
                  <path fill="#f35325" d="M0 0h11v11H0z"/>
                  <path fill="#81bc06" d="M12 0h11v11H12z"/>
                  <path fill="#05a6f0" d="M0 12h11v11H0z"/>
                  <path fill="#ffba08" d="M12 12h11v11H12z"/>
                </svg>
                <span>Sign in with Microsoft</span>
              </button>

              {/* Visual Divider */}
              <div className="flex items-center my-6 text-xs text-[#7A7067] uppercase font-semibold tracking-wider before:content-[''] before:flex-1 before:border-b before:border-[#F4EFE6] before:mr-3 after:content-[''] after:flex-1 after:border-b after:border-[#F4EFE6] after:ml-3">
                or use roadhouse account
              </div>

              {/* Traditional Form */}
              <form onSubmit={handleStandardLogin} className="w-full">
                
                {/* Email Field */}
                <div className="mb-5 w-full text-left">
                  <label htmlFor="email" className="block text-xs font-bold mb-2 uppercase tracking-wider text-[#2D251E]">
                    Email Address
                  </label>
                  <input
                    type="email"
                    id="email"
                    placeholder="name@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full h-11 px-4 border border-[#D5CFC6] rounded-md text-sm bg-[#FDFBF7] text-[#2D251E] outline-none transition-all duration-200 focus:border-[#004B2B] focus:bg-white focus:ring-1 focus:ring-[#004B2B]"
                    required
                  />
                </div>

                {/* Password Field */}
                <div className="mb-5 w-full text-left">
                  <label htmlFor="password" className="block text-xs font-bold mb-2 uppercase tracking-wider text-[#2D251E]">
                    Password
                  </label>
                  <input
                    type="password"
                    id="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full h-11 px-4 border border-[#D5CFC6] rounded-md text-sm bg-[#FDFBF7] text-[#2D251E] outline-none transition-all duration-200 focus:border-[#004B2B] focus:bg-white focus:ring-1 focus:ring-[#004B2B]"
                    required
                  />
                </div>

                {/* Submit Action Button */}
                <button
                  type="submit"
                  className="w-full h-12 bg-[#004B2B] text-white rounded-lg text-sm font-bold tracking-wide transition-all duration-200 hover:bg-[#00361F] focus:ring-2 focus:ring-[#FFC72C] active:scale-[0.98]"
                >
                  Sign In
                </button>
              </form>

              {/* Footer Option */}
              <div className="mt-6 text-center text-sm">
                <a href="#forgot" className="text-[#004B2B] font-bold hover:underline transition-all">
                  Forgot password?
                </a>
              </div>
            </div>
          </div>
        </>
      )}
    </main>
  );
}