import { useEffect, useState, useRef } from "react";
import TexasLogo from "../assets/texas-logo.png";
import Designer from "../assets/designer3.png";

/* ------------------------------------------------------------------ */
/* TOOLS + API                                                         */
/* ------------------------------------------------------------------ */
const TOOLS = [
  {
    key: "snow_mcp",
    toolId: "txrh-tool-RoadieRangerDev-6279-srch-dev",
    name: "ServiceNow (SNOW) MCP tool",
    desc: "Create and track support tickets",
  },
  {
    key: "tool_2",
    toolId: "txrh-tool-RoadieRangerDev-6279-StoSup-pHmO",
    name: "Tool 2",
    desc: "Second tool (name to be confirmed)",
  },
];

// const CONSENT_API = "https://roadieranger-dev.txrh.com/api/consent/verify";
const CONSENT_API = "http://127.0.0.1:8000/get_consent"

const LABEL = {
  pending: "Waiting",
  checking: "Checking consent...",
  needs: "Consent required",
  popup: "Consent Window Open",
  verify: "Verifying consent...",
  ok: "Consent present",
  error: "Check failed",
};

const ICON = {
  pending: "-",
  checking: "..",
  needs: "!",
  popup: "..",
  verify: "..",
  ok: "✓",
  error: "!",
};

/* ------------------------------------------------------------------ */
/* STYLE HELPERS                                                       */
/* ------------------------------------------------------------------ */
const iconBase =
  "flex shrink-0 items-center justify-center h-[40px] w-[40px] rounded-full border-[2px] font-bold text-[length:var(--body-m-size)]";

const iconStyle = (s) => {
  if (s === "ok")
    return "border-[var(--success-default)] bg-[var(--success-default)] text-[var(--success-contrast)]";
  if (s === "needs" || s === "error")
    return "border-[var(--warning-default)] text-[var(--warning-default)]";
  if (s === "popup") return "border-[#0f6cbd] text-[#0f6cbd]"; // wireframe blue
  if (s === "pending")
    return "border-[var(--neutral-400)] text-[var(--text-muted)]";
  return "border-[var(--primary-lighter)] text-[var(--primary-lighter)]"; // checking / verify
};

const Spinner = () => (
  <span
    aria-hidden="true"
    className="inline-block h-[14px] w-[14px] mr-2 align-[-2px] rounded-full border-2 border-[var(--primary-lighter)] border-r-transparent animate-spin motion-reduce:animate-none"
  />
);

/* ------------------------------------------------------------------ */
/* COMPONENT                                                           */
/* ------------------------------------------------------------------ */
const ConsentPage = () => {
  const [status, setStatus] = useState(TOOLS.map((_, i) => (i === 0 ? "checking" : "pending")));
  const [links, setLinks] = useState(TOOLS.map(() => ""));
  const [cur, setCur] = useState(0);
  const [notice, setNotice] = useState(""); // red message shown after a failed Verify
  const hasRun = useRef(false); // stops the double call in React StrictMode (dev)

  const total = TOOLS.length;
  const tool = TOOLS[cur];

  const setToolStatus = (i, value) =>
    setStatus((prev) => prev.map((s, idx) => (idx === i ? value : s)));

  const setToolLink = (i, value) =>
    setLinks((prev) => prev.map((l, idx) => (idx === i ? value : l)));

  // One API call for one tool
  const verifyTool = async (toolId) => {
    const response = await fetch(CONSENT_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ tool: toolId }),
    });
    if (!response.ok) {
      throw new Error(`Consent check failed: ${response.status}`);
    }
    return response.json();
  };

  // start        = index of the tool to (re)check first
  // afterConsent = true when the user clicked "Verify consent" (shows the verify loader)
  // Stops at the first tool that needs consent.
  const runChecks = async (start = 0, afterConsent = false) => {
    setNotice("");
    setStatus((prev) =>
      prev.map((s, idx) =>
        idx < start ? s : idx === start ? (afterConsent ? "verify" : "checking") : "pending"
      )
    );
    setLinks((prev) => prev.map((l, idx) => (idx < start ? l : "")));

    for (let i = start; i < TOOLS.length; i++) {
      const isVerify = afterConsent && i === start;

      setCur(i);
      setToolStatus(i, isVerify ? "verify" : "checking");

      try {
        const data = await verifyTool(TOOLS[i].toolId);
        console.log("Consent API response:", data);

        if (data.consent_required) {
          setToolLink(i, data.consent_link || "");
          if (isVerify) {
            setNotice("We couldn't confirm consent yet. Please provide consent and try again.");
          }
          setToolStatus(i, "needs"); // Provide consent button shows again
          return; // user has to give consent before we go further
        }

        setToolStatus(i, "ok"); // consent present, move on to next tool
      } catch (error) {
        console.error("Consent check failed:", error);
        setToolStatus(i, "error");
        return;
      }
    }
  };

  const handleConsentClick = () => {
    const link = links[cur];
    if (!link) return;
    window.open(link, "_blank", "noopener,noreferrer");
    setNotice("");
    setToolStatus(cur, "popup"); // show "Verify consent" button right away, no loader
  };

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;
    runChecks();
  }, []);

  return (
    <div className="flex w-full h-screen">
      {/* LEFT PANEL */}
      <div
        className="hidden flex p-[5%] lg:flex flex-[1] flex-col text-white"
        style={{
          background: `linear-gradient(var(--success-tint), rgba(0,0,0,0.75)), url('${Designer}')`,
          backgroundSize: "100% 100%, contain",
          backgroundPosition: "center, center",
          backgroundRepeat: "no-repeat, no-repeat",
          backgroundColor: "#1f1208",
        }}
      >
        <div className="flex h-[60px] font-extrabold">
          <img src={TexasLogo} alt="" />
        </div>

        <div className="mt-[10%]">
          <h2 className="font-black text-xl mb-5">
            One quick step before we get started.
          </h2>
          <p className="mt-5 text-[var(--neutral-200)] max-w-[500px] text-xl leading-8">
            Roadie Ranger needs your permission to use a few tools on your
            behalf. We'll check each one, and you only need to approve the ones
            that are missing.
          </p>
          <div className="text-xs text-white/50 mt-[10%]">
            &copy; 2026 Texas Roadhouse Core Web Portal. All rights reserved.
          </div>
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div className="flex flex-1 items-center justify-center bg-[var(--main-bg)] px-4">
        <div className="w-[90%] max-w-[520px] bg-[var(--white-100)] rounded-[22px] p-8 shadow-[0_10px_30px_rgba(0,0,0,0.12)]">
          <h3 className="text-[var(--primary-lighter)]">Connecting your tools</h3>
          <p className="mt-1 text-[length:var(--body-xs-size)] text-[var(--text-muted)]">
            Tool {cur + 1} of {total}
          </p>

          {/* Progress segments */}
          <div className="flex gap-[6px] my-[14px]">
            {TOOLS.map((t, i) => {
              const s = status[i];
              const cls =
                s === "ok"
                  ? "bg-[var(--success-default)] border-[var(--success-default)]"
                  : i === cur
                  ? "bg-[var(--success-tint)]/35 border-[var(--success-default)]"
                  : "bg-[var(--neutral-200)] border-[var(--neutral-300)]";
              return (
                <div
                  key={t.key}
                  className={`flex-1 h-[6px] rounded-[3px] border ${cls}`}
                />
              );
            })}
          </div>

          {/* Tool rows */}
          <div>
            {TOOLS.map((t, i) => {
              const s = status[i];
              return (
                <div
                  key={t.key}
                  className={`flex items-center gap-3 rounded-[10px] bg-[var(--white-100)] px-3 py-[10px] mb-2 ${
                    i === cur
                      ? "border-2 border-[var(--success-default)]"
                      : "border border-[var(--neutral-300)]"
                  }`}
                >
                  <div className={`${iconBase} ${iconStyle(s)}`} aria-hidden="true">
                    {ICON[s]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[length:var(--body-s-size)] font-bold text-[var(--black-900)] leading-tight">
                      {t.name}
                    </div>
                    <div className="text-[length:var(--body-xs-size)] leading-snug text-[var(--text-muted)]">
                      {t.desc}
                    </div>
                  </div>
                  <div className="ml-auto max-w-[170px] text-right text-[length:var(--body-xs-size)] leading-snug text-[var(--text-muted)]">
                    {(s === "checking" || s === "verify") && <Spinner />}
                    {LABEL[s]}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Action panel */}
          <div
            aria-live="polite"
            className="my-3 min-h-[96px] rounded-[10px] border border-dashed border-[var(--neutral-400)] bg-[var(--main-bg)] p-[14px]"
          >
            {status[cur] === "checking" && (
              <div className="flex items-center text-sm text-[var(--text-muted)]">
                <Spinner />
                <span>Checking your consent for {tool.name}...</span>
              </div>
            )}

            {status[cur] === "needs" && (
              <>
                {notice && (
                  <p className="text-sm text-[var(--danger-default)] font-semibold mb-2">
                    {notice}
                  </p>
                )}

                <p className="text-sm">
                  <strong>{tool.name}</strong> needs your permission to act on your behalf.
                </p>

                <button
                  type="button"
                  onClick={handleConsentClick}
                  disabled={!links[cur]}
                  className="text-[10px] p-3 mt-2 rounded-[5px] font-extrabold text-white bg-[var(--tertiary-shade)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Provide consent for {tool.name}
                </button>
              </>
            )}

            {status[cur] === "popup" && (
              <>
                <p className="text-sm">
                  Finish giving consent for <strong>{tool.name}</strong> in the new tab,
                  then come back here and click <strong>Verify consent</strong>.
                </p>

                <div className="flex items-center gap-4 mt-2">
                  <button
                    type="button"
                    onClick={() => runChecks(cur, true)}
                    className="text-[10px] p-3 rounded-[5px] font-extrabold text-white bg-[var(--success-default)] cursor-pointer"
                  >
                    Verify consent
                  </button>

                  <button
                    type="button"
                    onClick={handleConsentClick}
                    className="text-xs underline text-[var(--text-muted)] cursor-pointer bg-transparent border-none"
                  >
                    Open consent page again
                  </button>
                </div>
              </>
            )}

            {status[cur] === "verify" && (
              <div className="flex items-center text-sm text-[var(--text-muted)]">
                <Spinner />
                <span>Verifying consent for {tool.name}...</span>
              </div>
            )}

            {status[cur] === "error" && (
              <>
                <p className="text-sm text-[var(--danger-default)] font-semibold">
                  We couldn't check consent for {tool.name}. Please try again.
                </p>
                <button
                  type="button"
                  onClick={() => runChecks(cur)}
                  className="text-[10px] p-3 mt-2 rounded-[5px] font-extrabold text-white bg-[var(--tertiary-shade)] cursor-pointer"
                >
                  Try again
                </button>
              </>
            )}

            {status[cur] === "ok" && (
              <p className="text-sm text-[var(--success-default)] font-bold">
                Consent already provided for {tool.name}.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConsentPage;