const WarningPopUp = ({
  isOpen,
  onClose,
  onContinue,
  message,
  continueLabel = "Continue",
  cancelLabel = "Cancel",
  singleAction = false,
}) => {
  if (!isOpen) return null;

  const handleClose = (event) => {
    event?.stopPropagation?.();
    onClose?.();
  };

  const handleContinue = (event) => {
    event?.stopPropagation?.();
    if (onClose) onClose();
    if (onContinue) onContinue();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-md"
      onClick={handleClose}
    >
      <div
        className="flex flex-col w-full max-w-sm justify-center items-center p-6 gap-6 bg-white/90 rounded-2xl shadow-2xl border border-[#D5CFC6] text-center mx-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-3xl">⚠️</div>
        <p className="text-sm font-medium text-gray-800">
          {message || "To switch model in middle create a new chat"}
        </p>
        <div className="flex w-full gap-3">
          {!singleAction && (
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 border py-2.5 px-4 rounded-[10px] bg-[var(--neutral-200)] text-[var(--secondary-contrast)] font-semibold cursor-pointer transition-transform duration-150 active:scale-95"
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            onClick={handleContinue}
            className="flex-1 border py-2.5 px-4 rounded-[10px] bg-[var(--success-default)] text-[var(--secondary-default)] font-semibold cursor-pointer transition-transform duration-150 active:scale-95"
          >
            {singleAction ? cancelLabel : continueLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WarningPopUp;