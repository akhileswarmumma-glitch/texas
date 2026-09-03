const WarningPopUp = ({ isOpen, onClose, message }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-md">
      <div className="flex flex-col w-full max-w-sm justify-center items-center p-6 gap-6 bg-white/90 rounded-2xl shadow-2xl border border-[#D5CFC6] text-center mx-4">
        <div className="text-3xl">⚠️</div>
        <p className="text-sm font-medium text-gray-800">
          {message || "To switch model in middle create a new chat"}
        </p>
        <button
          onClick={onClose}
          className="border py-2.5 px-6 rounded-[10px] w-40 bg-[var(--success-default)] text-[var(--secondary-default)] font-semibold cursor-pointer transition-transform duration-150 active:scale-95"
        >
          Close
        </button>
      </div>
    </div>
  );
};

export default WarningPopUp;