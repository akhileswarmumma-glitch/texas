import { msalConfig, loginRequest, tokenRequest } from './authConfig.jsx';

// Mock state to track the logged-in user locally
let currentUser = null;

export const authService = {
    // 1. Initialize the Auth Client
    async initialize() {
        console.log("🛠️ [MSAL Mock] Initializing client application with config:", msalConfig);
        // Tomorrow: basic initialization like `this.publicClientApp = new PublicClientApplication(msalConfig);`
        return true;
    },

    // 2. Trigger Login (Simulating Pop-up Flow)
    async login() {
        console.log("🔄 [MSAL Mock] Opening login dialog...");
        
        return new Promise((resolve) => {
            setTimeout(() => {
                currentUser = {
                    username: "jane.doe@yourcompany.com",
                    name: "Jane Doe",
                    idToken: "mock_jwt_id_token_proving_identity",
                    tenantId: "mock_tenant_12345"
                };
                console.log("✅ [MSAL Mock] Login successful for:", currentUser.name);
                resolve(currentUser);
            }, 1000); // Simulated network latency
        });
    },

    // 3. Log Out
    async logout() {
        console.log("🔄 [MSAL Mock] Logging user out...");
        currentUser = null;
        window.location.reload();
    },

    // 4. Get Current Active User
    getCurrentUser() {
        return currentUser;
    },

    // 5. Fetch Access Token for Backend APIs
    async getAccessToken() {
        console.log("🔑 [MSAL Mock] Acquiring access token silently for scopes:", tokenRequest.scopes);
        
        return new Promise((resolve) => {
            setTimeout(() => {
                const mockAccessToken = "eyMockAccessTokenSentToBackendAPI.abcdefg.123456";
                resolve(mockAccessToken);
            }, 300);
        });
    }
};