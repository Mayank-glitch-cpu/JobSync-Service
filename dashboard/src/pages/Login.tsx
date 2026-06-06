import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";

export default function Login() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await signup(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Firebase:\s*/, "") : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card auth-card" onSubmit={onSubmit}>
        <h1 className="brand">JobSync</h1>
        <p className="muted">{mode === "login" ? "Sign in to your dashboard" : "Create your account"}</p>

        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Sign up"}
        </button>

        <p className="muted switch">
          {mode === "login" ? "No account?" : "Already have an account?"}{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </form>
    </div>
  );
}
