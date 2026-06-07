import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import ErrorBoundary from "./components/ErrorBoundary";

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="center muted">Loading…</div>;
  }

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/*" element={user ? <Dashboard /> : <Navigate to="/login" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}
