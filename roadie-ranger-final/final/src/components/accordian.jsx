import { useState } from "react";
import { ChevronDown } from "lucide-react";

const Accordion = () => {
    const [openIndex, setOpenIndex] = useState(null);

    const toggle = (index) => {
        setOpenIndex(openIndex === index ? null : index);
    };
    const data = [
        {
            question: "Need to check a gift card balance?",
            answer:
                "You can check your gift card balance online by entering your gift card number and PIN.",
        },
        {
            question: "Where is my PIN number?",
            answer:
                "Your PIN is located on the back of your physical gift card beneath the scratch-off area.",
        },
        {
            question: "My gift card has been lost, stolen, or damaged!",
            answer:
                "Please contact customer support for assistance with your gift card.",
        },
    ];

    return (
        <div className="w-[90%] mx-auto">
            {data.map((item, index) => (
                <div
                    key={index}
                    className="border-t border-gray-300"
                >
                    <button
                        onClick={() => toggle(index)}
                        className="flex w-full items-center justify-between py-5 text-left"
                    >
                        <h2 className="text-sm md:text-sm font-black uppercase tracking-wide">
                            {item.question}
                        </h2>

                        <ChevronDown
                            size={28}
                            className={`transition-transform duration-300 ${
                                openIndex === index ? "rotate-180" : ""
                            }`}
                        />
                    </button>

                    <div
                        className={`overflow-hidden transition-all duration-300 ${
                            openIndex === index
                                ? "max-h-[300px] pb-8"
                                : "max-h-0"
                        }`}
                    >
                        <p className="text-xs leading-8 text-gray-700 pr-10">
                            {item.answer}
                        </p>
                    </div>
                </div>
            ))}

            <div className="border-t border-gray-300" />
        </div>
    );
};

export default Accordion;