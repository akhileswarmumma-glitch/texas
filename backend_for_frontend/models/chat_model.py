from pydantic import BaseModel



class ChatRequest(BaseModel):
    user_message: str
    previous_response_id: str
    conversation_id: str
    