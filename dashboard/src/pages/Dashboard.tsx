import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { apiFetch, type Profile as ProfileT } from "../api";
import Agents from "../components/Agents";
import Pipeline from "../components/Pipeline";
import Profile from "../components/Profile";
import Onboarding from "./Onboarding";

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Register/refresh the user record on the server (creates users/<uid>), then send
  // brand-new users (no resume + no name yet) into the onboarding flow once.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/me")
      .then(() => apiFetch<ProfileT>("/api/profile"))
      .then((p) => {
        if (cancelled) return;
        setReady(true);
        const incomplete = !p.hasResume && !p.personal?.firstName;
        if (incomplete && location.pathname === "/") navigate("/onboarding", { replace: true });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">JobSync</div>
        <nav>
          <NavLink to="/agents">Agents</NavLink>
          <NavLink to="/pipeline">Pipeline</NavLink>
          <NavLink to="/profile">Profile</NavLink>
          <NavLink to="/onboarding">Set up profile</NavLink>
        </nav>
        <div className="sidebar-footer">
          <div className="muted email">{user?.email}</div>
          <button className="link" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="content">
        {error && <p className="error">Couldn't reach the server: {error}</p>}
        {!ready && !error ? (
          <p className="muted">Loading your workspace…</p>
        ) : (
          <Routes>
            <Route path="/agents" element={<Agents />} />
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="*" element={<Navigate to="/agents" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
