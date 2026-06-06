import { useEffect, useRef, useState } from "react";
import { apiFetch, type Agent, type Run } from "../api";

export default function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [active, setActive] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  async function refresh() {
    try {
      const [a, r] = await Promise.all([
        apiFetch<{ agents: Agent[] }>("/api/agents"),
        apiFetch<{ runs: Run[] }>("/api/runs"),
      ]);
      setAgents(a.agents);
      setRuns(r.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    refresh();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  function pollRun(id: string) {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const run = await apiFetch<Run>(`/api/runs/${encodeURIComponent(id)}`);
        setActive(run);
        if (run.status === "succeeded" || run.status === "failed") {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          await refresh();
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
  }

  async function run(agentId: string) {
    setError(null);
    setActive(null);
    try {
      const res = await apiFetch<{ run: Run; message?: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ agent: agentId, params: { lookbackHours: 48 } }),
      });
      setActive(res.run);
      if (res.run.status === "running") pollRun(res.run.id);
      else await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section>
      <h1>Agents</h1>
      <p className="muted">Pick an agent to run. Search finds jobs for you and fills your pipeline.</p>

      {error && <p className="error">{error}</p>}

      <div className="cards">
        {agents.map((a) => (
          <div className="card agent-card" key={a.id}>
            <div className="agent-head">
              <h3>{a.name}</h3>
              {a.status !== "available" && <span className="badge">{a.status}</span>}
            </div>
            <p className="muted">{a.description}</p>
            <button onClick={() => run(a.id)} disabled={a.status === "unavailable"}>
              Run {a.name}
            </button>
          </div>
        ))}
      </div>

      {active && (
        <div className="card run-panel">
          <div className="agent-head">
            <h3>Search run</h3>
            <span className="badge">{active.status}</span>
          </div>
          {active.status === "running" && active.progress && active.progress.length > 0 && (
            <ul className="progress">
              {active.progress.slice(-8).map((p, i) => (
                <li key={i} className="muted small">{p}</li>
              ))}
            </ul>
          )}
          {active.status === "succeeded" && (
            <p className="notice">
              Added {active.result?.added ?? 0} job{active.result?.added === 1 ? "" : "s"}
              {active.result?.updated ? `, updated ${active.result.updated}` : ""}. {active.summary}
            </p>
          )}
          {active.status === "failed" && <p className="error">{active.error}</p>}
        </div>
      )}

      <h2>Recent runs</h2>
      {runs.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Result</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.agent}</td>
                <td><span className="badge">{r.status}</span></td>
                <td className="muted">{r.result ? `+${r.result.added}` : r.error ? "error" : "—"}</td>
                <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
