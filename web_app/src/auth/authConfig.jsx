export const msalConfig = {
    auth: {
        clientId: "92eadf94-92d2-4249-b938-366f4b28c095", 
        authority: "https://login.microsoftonline.com/e714ef31-faab-41d2-9f1e-e6df4af16ab8", 
        redirectUri: window.location.origin,
        navigateToLoginRequestUrl: false 
    },
    cache: {
        cacheLocation: "sessionStorage",
        storeAuthStateInCookie: false,
    }
};

export const loginRequest = {
    scopes: ["User.Read"]
};