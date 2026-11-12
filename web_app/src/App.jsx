import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";

import LoginPage from "./components/loginPage.jsx";
import LandingPage from "./components/landingPage.jsx";
import ConsentPage from "./components/consent.jsx";

function App() {
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setAuthenticated] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/+$|\/+$/, '');
      const response = await fetch(`${apiBase || ''}/auth/me`, {
        method: "POST",
        credentials: "include",
      });

      if (response.ok) {
        setAuthenticated(true);
        setNeedsConsent(true);
      } else {
        setAuthenticated(false);
        setNeedsConsent(false);
      }
    } catch (error) {
      console.error(error);
      setAuthenticated(false);
      setNeedsConsent(false);
    } finally {
      setLoading(false);
    }
  };

  const handleConsentComplete = () => {
    setNeedsConsent(false);
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          isAuthenticated ? (
            <Navigate to="/" replace />
          ) : (
            <LoginPage />
          )
        }
      />

      <Route
        path="/"
        element={
          isAuthenticated ? (
            needsConsent ? (
              <ConsentPage onComplete={handleConsentComplete} />
            ) : (
              <LandingPage />
            )
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  );
}

export default App;