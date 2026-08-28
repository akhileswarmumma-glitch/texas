import Contact1 from '../assets/contact1.png'

const ContactCard = ({item}) =>{
    return(
        <>
            <div className="flex flex-col w-[30%] items-center gap-[3%]">
                <img src={item.url} alt="" />
                <h2 className='font-semibold'>{item.title}</h2>
                <p className='text-xs w-[90%]'>
                    {item.description}
                </p>
                <button className='border w-[50] pl-3 pr-3 text-lg bg-[#FFC72C] font-semibold border-[2px] rounded cursor-pointer'>{item.button_title}</button>
            </div>
        </>
    )
}


export default ContactCard