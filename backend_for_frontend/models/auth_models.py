from pydantic import BaseModel


class SSOToken(BaseModel):
    message: str
    sso_token: dict


class SuccessResponse(BaseModel):
    message: str

class ConversationResponse(BaseModel):
    message: str
    conversation_id: str

class UserData(BaseModel):
    name: str
    preferred_username: str
    
class UserDetailResponse(BaseModel):
    message:str
    data: UserData

class DeleteResponse(BaseModel):
    message: str
    
    