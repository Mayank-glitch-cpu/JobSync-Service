import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { initFirebase } from "./firebase";
import { AuthProvider } from "./auth";
import App from "./App";
import "./styles.css";

// Initialize Firebase (fetches /api/config) before mounting so auth is ready.
const root = createRoot(document.getElementById("root")!);

initFirebase()
  .then(() => {
    root.render(
      <StrictMode>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    root.render(
      <div className="boot-error">
        <h1>JobSync</h1>
        <p>Couldn't start: {err instanceof Error ? err.message : String(err)}</p>
      </div>,
    );
  });
