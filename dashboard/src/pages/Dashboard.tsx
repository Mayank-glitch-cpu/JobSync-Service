import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "../auth";
import { apiFetch } from "../api";
import Agents from "../components/Agents";
import Pipeline from "../components/Pipeline";

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Register/refresh the user record on the server (creates users/<uid>).
  useEffect(() => {
    apiFetch("/api/me")
      .then(() => setReady(true))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">JobSync</div>
        <nav>
          <NavLink to="/agents">Agents</NavLink>
          <NavLink to="/pipeline">Pipeline</NavLink>
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
            <Route path="*" element={<Navigate to="/agents" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
