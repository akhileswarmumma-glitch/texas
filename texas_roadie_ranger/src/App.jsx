import Chat from "./components/chat.jsx";
import texasImg from "./assets/texas-roadhouse.jpg";
import { FaUser } from "react-icons/fa";
import ContactCard from "./components/contactCard.jsx";
import Contact1 from './assets/contact1.png'
import Contact2 from './assets/contact2.png'
import Contact3 from './assets/contact3.png'
import Accordion from "./components/accordian.jsx";


function App() {
  const contactData = [
    {
      "url":Contact1,
      "title":"Career Opportunities",
      "description":"How would you like to become a Roadie? We work hard and play hard. Discover our employment opportunities.",
      "button_title":"Explore Careers"
    },
    {
      "url":Contact2,
      "title":"Texas Road House Employees and vendors",
      "description":"If you are a Roadie or vendor partner and have a concern that you would like to report, please access our employee relations and vendor hotline by clicking below.",
      "button_title":"EMPLOYEES &amp; VENDORS"
    },
    {
      "url":Contact3,
      "title":"Check Your Gift Card Balance",
      "description":"Need to check your gift card balance?",
      "button_title":"CHECK YOUR BALANCE"
    }
  ]
  return (
    <>
      <div className="w-full">
        <div className="">
          <div
            className="min-h-screen bg-center bg-cover bg-no-repeat"
            // style={{ backgroundImage: `url(${texasImg})` }}
          >
            <div className="flex justify-between  w-full mx-auto p-4 bg-black fixed">
              <h1 className="text-2xl font-bold text-[#004B2B]">
                TEXAS ROADHOUSE
              </h1>
              <div className="flex gap-[10px] items-center">
                <button 
                  onClick={() => window.open("https://txrh-ca-test.greenmeadow-610a0edf.eastus.azurecontainerapps.io/chat", "_blank")}
                  className="border rounded-[9999px] p-1.5 bg-[#004B2B] text-white hover:text-[#FFC72C] text-l border-white cursor-pointer transition-all duration-200 hover:border-[#FFC72C]"
                >
                  Dashboard
                </button>
                <button className="flex items-center justify-center border rounded-[50%] h-[40px] w-[40px] bg-[#004B2B] text-white transition-all duration-200 hover:text-[#FFC72C]"><FaUser className="text-lg" /></button>
              </div>
            </div>
            <img className="w-full h-[650px]" src={texasImg} alt="" />
            <div className="bg-[#c9912d] h-[750px] mb-[50px]">
              <div className="w-[92%] mx-auto flex gap-[2.5%] text-center mt-[50px]">
                {contactData.map((item,index)=>(
                    <ContactCard key={index} item={item} />
                ))}
              </div>
            </div>
            <div className="flex flex-col items-center justify-center">
                <h1 className="text-3xl font-bold text-[#a5022f]">Frequently Asked Questions</h1>
                <div className="mt-5 text-sm">
                  <Accordion />
                </div>
                
            </div>
            <Chat />
          </div>
        </div>
      </div>
    </>
  );
}

export default App;
