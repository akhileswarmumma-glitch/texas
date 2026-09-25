# Texas Roadhouse Digital Assistant

This repository contains the active application layers for the Texas Roadhouse assistant experience. The README focuses on the two folders used in the current implementation: `web_app` and `backend_for_frontend`.


---

## 1. `web_app`

### Purpose
`web_app` is the React + Vite frontend for the customer-facing assistant experience. It provides the chat interface, mode selection, authentication flows, and voice-enabled interactions.

### Main responsibilities
- User login and authenticated session handling
- Text chat and agent conversation experience
- Voice chat flow with microphone capture and playback
- Chat message rendering, markdown support, and consent/resource links
- UI states for loading, thinking, errors, and user interruptions

### Typical stack
- React
- Vite
- JavaScript/JSX
- Tailwind CSS
- Azure MSAL for authentication
- React Markdown for rendered responses

### Run locally
```bash
cd web_app
npm install
npm run dev
```

This starts the frontend development server for local testing in the browser.

### Important folders
- `src/components` — chat, voice, landing, login, and UI components
- `src/auth` — authentication configuration and services
- `src/assets` — static assets
- `public` — public app resources

---

## 2. `backend_for_frontend`

### Purpose
`backend_for_frontend` is the FastAPI backend that acts as the application gateway between the frontend and the supporting services. It handles authentication, chat requests, cookie/session flow, and voice communication.

### Main responsibilities
- API endpoints for auth and session management
- Text chat orchestration and request routing
- Cookie and session handling
- Voice chat support and WebSocket-based communication
- Integration with Azure services and local caching

### Typical stack
- Python
- FastAPI
- Uvicorn
- Azure Identity / Key Vault / Cosmos integration
- dotenv-based configuration
- Diskcache session caching

### Run locally
```bash
cd backend_for_frontend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

If the project is using Poetry instead of a requirements file, use:
```bash
cd backend_for_frontend
poetry install
poetry run uvicorn main:app --reload
```

### Key folders
- `router` — API route modules for auth, cookies, text chat, and voice chat
- `models` — request/response models
- `utils` — shared helpers, logging, and utility functions

---

## 3. How the two parts fit together

- `web_app` is the browser application used by the end user.
- `backend_for_frontend` exposes the API and orchestration layer used by the frontend.
- Together, they provide the end-to-end conversational experience for the Texas Roadhouse assistant.

---

## 4. Notes

This document intentionally focuses only on the active frontend and BFF layers for the current implementation. The excluded folders listed above are not part of the primary runtime setup described here.
