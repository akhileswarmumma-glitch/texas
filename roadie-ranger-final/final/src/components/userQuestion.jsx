const UserQuestion = ({ message }) => {
    return (
        <div className="flex justify-end w-full mt-4">
            <div className="max-w-[80%] break-words rounded-[14px_14px_4px_14px] px-3 py-2.5 bg-[var(--primary-light)] mr-2 text-white">
                {message}
            </div>
        </div>
    );
};

export default UserQuestion;