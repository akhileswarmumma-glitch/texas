import { useEffect, useRef, useState } from "react";
import Chat from "./chat.jsx";
import texasImg from "../assets/texas-roadhouse.jpg";
import texasLogo from "../assets/texas-logo.png";
import { FaUser } from "react-icons/fa";
import { FiLogOut } from "react-icons/fi";
import ContactCard from "./contactCard.jsx";
import Contact1 from '../assets/contact1.png'
import Contact2 from '../assets/contact2.png'
import Contact3 from '../assets/contact3.png'
import Accordion from "./accordian.jsx";

// ---------------------------------------------------------
// Scroll-Spy hook: on every scroll, checks each section's real
// position on the page and picks whichever one has most recently
// crossed just below the fixed header. That section becomes the
// "active" nav item.
//
// This is more reliable than IntersectionObserver for tall
// sections: IO can fire multiple "isIntersecting" entries in the
// same batch (e.g. bottom of one section + top of the next both
// visible at once), and whichever gets processed last in that
// batch "wins" — causing the highlight to get stuck. Comparing
// actual scroll position avoids that race, and also doesn't
// depend on the nav's label order matching the DOM order of the
// sections.
// ---------------------------------------------------------

function useScrollSpy(sectionIds, offsetPx = 120) {
  const [activeId, setActiveId] = useState(sectionIds[0]);

  useEffect(() => {
    let ticking = false;

    const computeActive = () => {
      // Among all sections that have crossed the offset line
      // (top <= 0 after subtracting the header offset), pick the
      // one whose top is CLOSEST to that line — i.e. the most
      // recently entered section. This is based on each section's
      // real position on the page, so it works correctly even if
      // the nav's label order doesn't match the DOM order of the
      // sections (as is the case here: "Opportunities" sits before
      // "Knowledge Base" in the markup, but appears after it in nav).
      let current = sectionIds[0];
      let bestTop = -Infinity;

      for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top - offsetPx;
        if (top <= 0 && top > bestTop) {
          bestTop = top;
          current = id;
        }
      }

      // Special case: if the user has scrolled to the very
      // bottom of the page, force the last section active
      // (handles short/empty final sections gracefully).
      const atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 2;
      if (atBottom) {
        current = sectionIds[sectionIds.length - 1];
      }

      setActiveId(current);
      ticking = false;
    };

    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(computeActive);
        ticking = true;
      }
    };

    computeActive(); // set correct state on initial mount
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll);
    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, [sectionIds, offsetPx]);

  return activeId;
}

const LandingPage = () => {
    // Nav items in the same order they appear on the page.
    // Update the `id`s here if your section wrapper ids differ.
    const headerRef = useRef(null);
    const [headerHeight, setHeaderHeight] = useState(96);


    const NAV_ITEMS = [
      { id: "screen-home", label: "Home" },
      { id: "contact-section", label: "My Queries" },
      // { id: "faq-section", label: "Knowledge Base" },
      // { id: "opportunities-section", label: "Opportunities" },
    ];
     useEffect(() => {
    const measure = () => {
      if (headerRef.current) {
        setHeaderHeight(headerRef.current.getBoundingClientRect().height);
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const activeSection = useScrollSpy(
    NAV_ITEMS.map((item) => item.id),
    headerHeight + 16 // small buffer past the header
  );

  const queryCards = [
    {
      id: 1,
      icon: "💻",
      title: "IT & Technical Support",
      description:
        "Password resets, POS/device issues, or access requests — get instant help or escalate to the IT Helpdesk.",
      buttonText: "Submit IT Ticket",
      type: "it-support",
      buttonColor: "#0D47A1",
      buttonBorderColor: "#0D47A1",
      buttonTextColor: "#FFFFFF"
    },
    {
      id: 2,
      icon: "💰",
      title: "HR & Payroll",
      description:
        "Questions on pay stubs, benefits enrollment, PTO balances, or scheduling — answered instantly by Roadie Ranger.",
      buttonText: "Ask HR",
      type: "hr-payroll",
      buttonColor: "#2E7D32",
      buttonBorderColor: "#2E7D32",
      buttonTextColor: "#FFFFFF"
    },
    {
      id: 3,
      icon: "🛡️",
      title: "Employee Relations Hotline",
      description:
        "Have a concern to report confidentially? Reach our employee relations hotline anytime, day or night.",
      buttonText: "Report a Concern",
      type: "employee-relations",
      buttonColor: "#FFFFFF",
      buttonBorderColor: "#D32F2F",
      buttonTextColor: "#D32F2F"
    },
  ];
  const [userInfo, setUserInfo] = useState("")
  const [userEmail, setUserEmail] = useState("")
  const [userLoading, setUserLoading] = useState(true)

  useEffect(()=>{
    
    // Try to load from sessionStorage first
    const cachedName = sessionStorage.getItem("userInfo");
    const cachedEmail = sessionStorage.getItem("userEmail");
    
    if (cachedName && cachedEmail) {
      setUserInfo(cachedName);
      setUserEmail(cachedEmail);
      setUserLoading(false);
      return;
    }

    const fetchUserDetails = async ()=>{
      try {
        const resp = await fetch("https://txrh-app-roadierangerdev-6279-stosup-phmo.azurewebsites.net/get_user_details",{
          method: "GET",
          credentials: "include"
        })
        
        
        if (!resp.ok) {
          throw new Error(`API returned status ${resp.status}`);
        }

        const resp_data = await resp.json();

        const data = resp_data.data;
        const name = data?.name || "";
        const email = data?.preferred_username || "";
        // Store in sessionStorage for faster subsequent loads
        if (name) sessionStorage.setItem("userInfo", name);
        if (email) sessionStorage.setItem("userEmail", email);

        setUserInfo(name);
        setUserEmail(email);
      } catch (error) {
        console.error("❌ [LandingPage] Error fetching user details:", error);
        setUserInfo("");
        setUserEmail("");
      } finally {
        setUserLoading(false);
        console.log("⏹️ [LandingPage] Finished fetching user details")
      }
    } 
    
    fetchUserDetails();
  }, []
  )
    const [showMenu, setShowMenu] = useState(false);
    const profileRef = useRef(null);
    useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        profileRef.current &&
        !profileRef.current.contains(event.target)
      ) {
        setShowMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

    const handleLogout = async () => {
        // Clear cached user data
        sessionStorage.removeItem("userInfo");
        sessionStorage.removeItem("userEmail");
        
        await fetch("/logout", {
            method: "POST",
            credentials: "include",
        });

        window.location.href = "/";
    };

    return (
        <>
            <div className="w-full">
                <div className="" id="screen-home">
                    <div
                        className="min-h-screen bg-center bg-cover bg-no-repeat"
                    >
                        <header ref={headerRef} className="flex justify-between items-center  w-full mx-auto p-4 bg-[var(--secondary-contrast)] sticky top-0 left-0 z-50">
                            <div className="flex h-[50px] ml-6 ">
                                <img src={texasLogo} alt="" />
                            </div>
                            <nav className="flex gap-7 text-[16px] font-bold">
                                {NAV_ITEMS.map((item) => (
                                    <a
                                        key={item.id}
                                        href={`#${item.id}`}
                                        className={`pb-1 ${activeSection === item.id
                                                ? "border-b-2 border-[var(--tertiary-default)] text-[var(--primary-contrast)]"
                                                : "text-[var(--primary-contrast)]"
                                            }`}
                                    >
                                        {item.label}
                                    </a>
                                ))}
                            </nav>

                            <div ref={profileRef} className="relative flex items-center mr-4">
                            <button
                                onClick={() => setShowMenu(!showMenu)}
                                className="flex items-center justify-center border rounded-full h-[40px] w-[40px] font-bold bg-[var(--tertiary-default)] text-white cursor-pointer"
                            >
                                {
                                  userInfo
                                    ? userInfo
                                        .split(" ")
                                        .slice(0, 2)
                                        .map(name => name[0])
                                        .join("")
                                        .toUpperCase()
                                    : <FaUser size={18} />
                                }
                            </button>

                            {/* {showMenu && (
                                <div className="absolute top-12 right-0 min-w-[140px] bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                                  <div className="w-full flex items-center cursor-pointer gap-3 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
                                      {userInfo}
                                  </div>
                                  <div className="w-full flex items-center cursor-pointer gap-3 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
                                      {userEmail}
                                  </div>
                                    <button
                                        className="w-full flex items-center cursor-pointer gap-3 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                                        onClick={handleLogout}
                                    >
                                        <FiLogOut size={16} />
                                        Logout
                                    </button>
                                </div>
                            )} */}
                            {showMenu && (
                              <div className="absolute top-12 right-0 min-w-[140px] bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden z-50">
                                
                                <div className="px-4 py-3 border-b border-gray-100">
                                  <p className="text-sm font-semibold text-gray-900 truncate">
                                    {userInfo}
                                  </p>
                                  <p className="text-xs text-gray-500 truncate">
                                    {userEmail}
                                  </p>
                                </div>

                                <button
                                  className="w-full flex items-center justify-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer"
                                  onClick={handleLogout}
                                >
                                  <FiLogOut size={16} />
                                  Logout
                                </button>
                              </div>
                            )}
                            
                        </div>
                        </header>
                        <section className="flex items-center relative h-[420px] bg-cover bg-center m-o"
                            style={{
                                backgroundImage:
                                    "linear-gradient(var(--primary-lighter), rgba(0,0,0,0.6)), url('https://images.unsplash.com/photo-1556742393-d75f468bfcb0?q=80&w=1600')",
                                position: "relative"
                            }}>
                            <div className="max-w-[900px] w-full mx-auto text-center text-white px-10">
                                <div className="text-[var(--secondary-contrast)] text-[14px] font-[800] mb-4 tracking-[2px]">
                                    YOUR SUPPORT HUB
                                </div>
                                <h1 className="text-white leading-[1.2]">Hey {!userLoading && userInfo? userInfo.split(" ")[0] : (!userLoading ? "Roadie" : "...")}, how can we help today?</h1>
                                <p className="max-w-[600px] mx-auto text-[var(--neutral-200)] leading-8 text-center text-[18px] text-center mt-7">
                                    Resolve HR &amp; IT queries, browse the knowledge base, or discover new
                                    opportunities across Texas Roadhouse. Need to talk it through? Roadie
                                    Ranger is just a tap away in the corner.
                                </p>
                            </div>
                        </section>
                        <div className="flex justify-center bg-[var(--black-900)] text-[var(--white-100)] items-center pl-[20px] pr-[20px] pt-[14px] pb-[14px]">
                            📢 New: Support is here whenever you need it — reach out anytime for help.Get Support
                            {/* <a href="#opportunities-section" className="text-[var(--tertiary-tint)] font-[800] text-decoration: underline">View Opportunities</a> */}
                        </div>
                        <section id="contact-section" className="flex flex-col justify-center items-center m-0 p-[80px_40px_40px_40px] bg-[var(--primary-bg)]">
                            <div className="text-[var(--primary-contrast)] tracking-[2px] font-[700] text-[14px] mb-[12px]">
                                MY QUERIES
                            </div>
                            <h2 className="!mb-[12px]">What do you need help with?</h2>
                            <p className="max-w-[620px] mb-10 text-center text-[var(--primary-contrast)]">Submit a ticket, ask a question, or report a concern — routed instantly to the
                                right team or to Roadie Ranger.</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[24px] ">
                                {queryCards.map((card) => (
                                    <div key={card.id} className="flex flex-col border gap-4 border-[var(--neutral-300)] items-start justify-center rounded-[16px] p-5 bg-[var(--white-100)] border">
                                        <div className="text-4xl mb-4">{card.icon}</div>

                                        <h6>{card.title}</h6>

                                        <p>{card.description}</p>
                                    </div>
                                ))}
                            </div>
                        </section>
                        <Chat handleLogout={handleLogout} />
                    </div>
                </div>
            </div>
        </>
    )
}

export default LandingPage