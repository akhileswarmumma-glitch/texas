# Roadie Ranger

This build uses the Roadie Ranger visual design as the landing experience while retaining the web_app application's authentication, SSE chat, ServiceNow consent/resource handling, session creation, and voice WebSocket functionality.

## UX
- Roadie Ranger is the landing page itself.
- No floating chat launcher/icon.
- New Chat resets the conversation and requests a fresh backend conversation ID.
- Text and voice are available directly from the landing page.

## API behavior
The chat implementation uses the web_app `/api/chatV1` SSE contract and the existing authenticated backend endpoints. Voice uses the existing `/ws/voice` WebSocket flow.
