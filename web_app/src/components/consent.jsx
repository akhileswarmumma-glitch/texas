import { useEffect, useState, useRef } from "react";
import { useTranslation, Trans } from "react-i18next";
import TexasLogo from "../assets/texas-logo.png";
import Designer from "../assets/designer3.png";
import { Dropdown } from "./dropDown.jsx";


/* ------------------------------------------------------------------ */
/* TOOLS + API                                                         */
/* ------------------------------------------------------------------ */
const TOOLS = [
  {
    key: "snow_mcp",
    toolId: "snow",
    toolName: "Snow-Check-Consent",
    name: "ServiceNow Support",
    desc: "Access knowledge articles and manage support tickets.",
  },
  {
    key: "tool_2",
    toolId: "ai-search",
    toolName: "AI-Search-Check-Consent",
    name: "Knowledge Search",
    desc: "Find relevant knowledge resources for your questions.",
  },
];
const CONSENT_API = "http://127.0.0.1:8000/get_consent";

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
  if (s === "popup") return "border-[#0f6cbd] text-[#0f6cbd]";
  if (s === "pending")
    return "border-[var(--neutral-400)] text-[var(--text-muted)]";
  return "border-[var(--primary-lighter)] text-[var(--primary-lighter)]";
};

const Spinner = () => (
  <span
    aria-hidden="true"
    className="inline-block h-[14px] w-[14px] mr-2 align-[-2px] rounded-full border-2 border-[var(--primary-lighter)] border-r-transparent animate-spin"
  />
);

/* ------------------------------------------------------------------ */
/* COMPONENT                                                           */
/* ------------------------------------------------------------------ */
const ConsentPage = ({ onComplete }) => {
  const { t, i18n } = useTranslation();
  const selectedLanguage = (i18n.resolvedLanguage || i18n.language || "en")
    .split("-")[0]
    .toLowerCase();

  const [status, setStatus] = useState(
    TOOLS.map((_, i) => (i === 0 ? "checking" : "pending"))
  );
  const [links, setLinks] = useState(TOOLS.map(() => ""));
  const [cur, setCur] = useState(0);
  const [verifyFailed, setVerifyFailed] = useState(false);
  const hasRun = useRef(false);

  const total = TOOLS.length;
  const tool = TOOLS[cur];
  const currentToolName = t(`consent.tools.${tool.key}.name`);

  const setToolStatus = (i, value) =>
    setStatus((prev) => prev.map((s, idx) => (idx === i ? value : s)));

  const setToolLink = (i, value) =>
    setLinks((prev) => prev.map((l, idx) => (idx === i ? value : l)));

  // One API call for one tool
  const verifyTool = async (toolId,toolName) => {
    const response = await fetch(CONSENT_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": i18n.language,
      },
      credentials: "include",
      body: JSON.stringify({ tool: toolId, agent_name: toolName }),
    });
    if (!response.ok) {
      throw new Error(`Consent check failed: ${response.status}`);
    }
    return response.json();
  };

  const runChecks = async (start = 0, afterConsent = false) => {
    setVerifyFailed(false);
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
        const data = await verifyTool(TOOLS[i].toolId, TOOLS[i].toolName);
        console.log("Consent API response:", data);

        if (data.consent_required) {
          setToolLink(i, data.consent_link || "");
          if (isVerify) {
            setVerifyFailed(true);
          }
          setToolStatus(i, "needs");
          return;
        }

        setToolStatus(i, "ok");
      } catch (error) {
        console.error("Consent check failed:", error);
        setToolStatus(i, "error");
        return;
      }
    }

    if (typeof onComplete === "function") {
      onComplete();
    }
  };

  const handleConsentClick = () => {
    const link = links[cur];
    if (!link) return;
    window.open(link, "_blank", "noopener,noreferrer");
    setVerifyFailed(false);
    setToolStatus(cur, "popup");
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
          <h2 className="font-black text-xl mb-5">{t("consent.hero_title")}</h2>
          <p className="mt-5 text-[var(--neutral-200)] max-w-[500px] text-xl leading-8">
            {t("consent.hero_subtitle")}
          </p>
          <div className="text-xs text-white/50 mt-[10%]">
            {t("login.copyright", { year: new Date().getFullYear() })}
          </div>
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div className="relative flex flex-1 items-center justify-center bg-[var(--main-bg)] px-4">
        <div className="absolute top-5 right-6 z-10">
          <Dropdown
              ariaLabel={t("header.select_language")}
              value={selectedLanguage}
              onChange={(lang) => {
                void i18n.changeLanguage(lang);
              }}
              options={[
                  { value: "en", label: "English" },
                  { value: "es", label: "Español" },
              ]}
          />
        </div>
        <div className="w-[90%] max-w-[520px] bg-[var(--white-100)] rounded-[22px] p-8 shadow-[0_10px_30px_rgba(0,0,0,0.12)]">
          <h3 className="text-[var(--primary-lighter)]">
            {t("consent.card_title")}
          </h3>
          <p className="mt-1 text-[length:var(--body-xs-size)] text-[var(--text-muted)]">
            {t("consent.progress", { current: cur + 1, total })}
          </p>

          {/* Progress segments */}
          <div className="flex gap-[6px] my-[14px]">
            {TOOLS.map((tItem, i) => {
              const s = status[i];
              const cls =
                s === "ok"
                  ? "bg-[var(--success-default)] border-[var(--success-default)]"
                  : i === cur
                  ? "bg-[var(--success-tint)]/35 border-[var(--success-default)]"
                  : "bg-[var(--neutral-200)] border-[var(--neutral-300)]";
              return (
                <div
                  key={tItem.key}
                  className={`flex-1 h-[6px] rounded-[3px] border ${cls}`}
                />
              );
            })}
          </div>

          {/* Tool rows */}
          <div>
            {TOOLS.map((tItem, i) => {
              const s = status[i];
              return (
                <div
                  key={tItem.key}
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
                      {t(`consent.tools.${tItem.key}.name`)}
                    </div>
                    <div className="text-[length:var(--body-xs-size)] leading-snug text-[var(--text-muted)]">
                      {t(`consent.tools.${tItem.key}.desc`)}
                    </div>
                  </div>
                  <div className="ml-auto max-w-[170px] text-right text-[length:var(--body-xs-size)] leading-snug text-[var(--text-muted)]">
                    {(s === "checking" || s === "verify") && <Spinner />}
                    {t(`consent.status.${s}`)}
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
                <span>
                  {t("consent.actions.checking_message", {
                    toolName: currentToolName,
                  })}
                </span>
              </div>
            )}

            {(status[cur] === "needs" || status[cur] === "popup") && (
              <>
                {verifyFailed && (
                  <p className="text-sm text-[var(--danger-default)] font-semibold mb-2">
                    {t("consent.actions.needs_notice")}
                  </p>
                )}

                <p className="text-sm">
                  <Trans
                    i18nKey="consent.actions.consent_instructions"
                    values={{ toolName: currentToolName }}
                    components={{ bold: <strong /> }}
                  />
                </p>

                <div className="flex items-center gap-3 mt-2">
                  <button
                    type="button"
                    onClick={handleConsentClick}
                    disabled={!links[cur]}
                    className="text-[10px] p-3 rounded-[5px] font-extrabold text-white bg-[var(--tertiary-shade)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t("consent.actions.provide_consent_btn", {
                      toolName: currentToolName,
                    })}
                  </button>

                  <button
                    type="button"
                    onClick={() => runChecks(cur, true)}
                    disabled={status[cur] !== "popup"}
                    className="text-[10px] p-3 rounded-[5px] font-extrabold text-white bg-[var(--success-default)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t("consent.actions.verify_consent_btn")}
                  </button>
                </div>
              </>
            )}
            
            {status[cur] === "verify" && (
              <div className="flex items-center text-sm text-[var(--text-muted)]">
                <Spinner />
                <span>
                  {t("consent.actions.verifying_message", {
                    toolName: currentToolName,
                  })}
                </span>
              </div>
            )}

            {status[cur] === "error" && (
              <>
                <p className="text-sm text-[var(--danger-default)] font-semibold">
                  {t("consent.actions.error_message", {
                    toolName: currentToolName,
                  })}
                </p>
                <button
                  type="button"
                  onClick={() => runChecks(cur)}
                  className="text-[10px] p-3 mt-2 rounded-[5px] font-extrabold text-white bg-[var(--tertiary-shade)] cursor-pointer"
                >
                  {t("consent.actions.retry_btn")}
                </button>
              </>
            )}

            {status[cur] === "ok" && (
              <p className="text-sm text-[var(--success-default)] font-bold">
                {t("consent.actions.ok_message", {
                  toolName: currentToolName,
                })}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConsentPage;