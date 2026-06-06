import { useEffect, useState } from "react";
import { apiFetch, type Agent, type Run } from "../api";

export default function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  }, []);

  async function run(agentId: string) {
    setNotice(null);
    setError(null);
    try {
      const res = await apiFetch<{ message: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ agent: agentId }),
      });
      setNotice(res.message);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section>
      <h1>Agents</h1>
      <p className="muted">Pick an agent to run. Search finds jobs for you; Auto-Apply submits applications.</p>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      <div className="cards">
        {agents.map((a) => (
          <div className="card agent-card" key={a.id}>
            <div className="agent-head">
              <h3>{a.name}</h3>
              {a.status === "coming-soon" && <span className="badge">coming soon</span>}
            </div>
            <p className="muted">{a.description}</p>
            <button onClick={() => run(a.id)}>Run {a.name}</button>
          </div>
        ))}
      </div>

      <h2>Recent runs</h2>
      {runs.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Requested</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.agent}</td>
                <td>
                  <span className="badge">{r.status}</span>
                </td>
                <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
