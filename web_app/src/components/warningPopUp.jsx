const WarningPopUp = ({
  isOpen,
  onClose,
  onContinue,
  message,
  continueLabel = "Continue",
  cancelLabel = "Cancel",
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-md">
      <div className="flex flex-col w-full max-w-sm justify-center items-center p-6 gap-6 bg-white/90 rounded-2xl shadow-2xl border border-[#D5CFC6] text-center mx-4">
        <div className="text-3xl">⚠️</div>
        <p className="text-sm font-medium text-gray-800">
          {message || "To switch model in middle create a new chat"}
        </p>
        <div className="flex w-full gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 border py-2.5 px-4 rounded-[10px] bg-[var(--neutral-200)] text-[var(--secondary-contrast)] font-semibold cursor-pointer transition-transform duration-150 active:scale-95"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onContinue || onClose}
            className="flex-1 border py-2.5 px-4 rounded-[10px] bg-[var(--success-default)] text-[var(--secondary-default)] font-semibold cursor-pointer transition-transform duration-150 active:scale-95"
          >
            {continueLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WarningPopUp;