import { useState, useRef, useEffect } from "react";

const DEFAULT_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

export function Dropdown({
  options = DEFAULT_LANGUAGES,
  value,
  onChange,
  ariaLabel = "Select language",
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  const selectedOption =
    options.find((opt) => opt.value === value) || options[0];

  // Close when clicking outside or pressing Escape
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <div ref={dropdownRef} className="relative inline-block text-left">
      {/* Trigger Pill */}
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        onClick={() => setIsOpen((prev) => !prev)}
        className="group inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/25 bg-[var(--maroon-primary)] py-1.5 pl-3.5 pr-2.5 text-xs font-semibold tracking-wide text-white shadow-sm transition-all duration-200 hover:border-white/50 hover:brightness-110 focus:border-white focus:outline-none focus:ring-2 focus:ring-white/30"
      >
        <span>{selectedOption?.label}</span>

        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-3.5 w-3.5 text-white/80 transition-transform duration-200 group-hover:text-white ${
            isOpen ? "rotate-180" : ""
          }`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <ul
          role="listbox"
          className="absolute right-0 z-50 mt-2 min-w-[8.5rem] origin-top-right rounded-xl border border-gray-100 bg-white p-1 shadow-xl ring-1 ring-black/5"
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <li key={option.value} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setIsOpen(false);
                  }}
                  className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs transition-colors ${
                    isSelected
                      ? "bg-[var(--maroon-primary)]/10 font-semibold text-[var(--maroon-primary)]"
                      : "font-medium text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  <span>{option.label}</span>

                  {isSelected && (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-3.5 w-3.5 shrink-0 text-[var(--maroon-primary)]"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}