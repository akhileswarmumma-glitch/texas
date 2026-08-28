// src/components/dashboard.jsx
import React from 'react';
import { useMsal } from "@azure/msal-react";

export default function Dashboard() {
    const { instance, accounts } = useMsal();
    const user = accounts[0];

    const handleLogout = () => {
        instance.logoutRedirect().catch(e => console.error(e));
    };

    return (
        <div className="min-h-screen bg-gray-100 p-8">
            <nav className="bg-[#004B2B] text-white p-4 rounded-xl shadow-lg flex justify-between items-center mb-8">
                <div className="flex items-center gap-3">
                    <span className="text-2xl">🤠</span>
                    <h1 className="font-extrabold text-xl tracking-tight">TEXAS ROADHOUSE MANAGEMENT</h1>
                </div>
                <div className="flex items-center gap-4">
                    <span className="text-sm bg-white/20 px-3 py-1 rounded-full font-medium">
                        {user?.name}
                    </span>
                    <button 
                        onClick={handleLogout}
                        className="bg-red-600 hover:bg-red-700 text-white text-sm px-4 py-2 rounded-lg font-bold transition-colors cursor-pointer"
                    >
                        Sign Out
                    </button>
                </div>
            </nav>

            <main className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-white p-6 rounded-xl shadow-md border border-gray-200">
                    <h3 className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-2">Corporate Profile</h3>
                    <p className="text-sm font-medium text-gray-800">Email: {user?.username}</p>
                    <p className="text-xs text-gray-400 mt-1 font-mono">Tenant ID: {user?.tenantId}</p>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-md border border-gray-200 md:col-span-2">
                    <h3 className="text-[#004B2B] text-lg font-bold mb-2">Legendary Dashboard Portal</h3>
                    <p className="text-gray-600 text-sm">Your secure enterprise integration is active. Select an option from your internal routing controls to begin managing catering metrics, orders, or distribution paths.</p>
                </div>
            </main>
        </div>
    );
}