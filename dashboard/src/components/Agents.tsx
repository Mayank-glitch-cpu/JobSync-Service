import { useEffect, useRef, useState } from "react";
import { apiFetch, type Agent, type Run } from "../api";

const AGENT_LABEL: Record<string, string> = {
  search: "Search",
  "auto-apply": "Auto-Apply",
};

function agentLabel(id: string): string {
  return AGENT_LABEL[id] ?? id;
}

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

  function stopPolling() {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
  }

  function pollRun(id: string) {
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      try {
        const run = await apiFetch<Run>(`/api/runs/${encodeURIComponent(id)}`);
        // Only update the panel if this run is still the selected one.
        setActive((cur) => (cur && cur.id === id ? run : cur));
        if (run.status === "succeeded" || run.status === "failed") {
          stopPolling();
          await refresh();
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
  }

  // Select a run from the recent-runs list and show its full log on the right.
  async function selectRun(r: Run) {
    setActive(r);
    stopPolling();
    try {
      const full = await apiFetch<Run>(`/api/runs/${encodeURIComponent(r.id)}`);
      setActive(full);
      if (full.status === "running" || full.status === "queued") pollRun(full.id);
    } catch {
      /* the list row data is enough to show something */
    }
  }

  async function run(agentId: string) {
    setError(null);
    try {
      const res = await apiFetch<{ run: Run; message?: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ agent: agentId, params: { lookbackHours: 48 } }),
      });
      // Surface a server message (e.g. Auto-Apply "coming soon") in the log panel.
      const seeded =
        res.message && (!res.run.progress || res.run.progress.length === 0)
          ? { ...res.run, progress: [res.message] }
          : res.run;
      setActive(seeded);
      if (res.run.status === "running") pollRun(res.run.id);
      else await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section>
      <h1>Agents</h1>
      <p className="muted">
        Run an agent and watch its live log on the right. Click any recent run to replay its log.
      </p>

      {error && <p className="error">{error}</p>}

      <div className="agents-layout">
        <div className="agents-main">
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

          <h2>Recent runs</h2>
          {runs.length === 0 ? (
            <p className="muted">No runs yet.</p>
          ) : (
            <table className="table runs-table">
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
                  <tr
                    key={r.id}
                    className={`run-row${active?.id === r.id ? " selected" : ""}`}
                    onClick={() => selectRun(r)}
                  >
                    <td>{agentLabel(r.agent)}</td>
                    <td>
                      <span className={`badge status-${r.status}`}>{r.status}</span>
                    </td>
                    <td className="muted">
                      {r.result ? `+${r.result.added}` : r.error ? "error" : "—"}
                    </td>
                    <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <LogPanel run={active} onClose={() => setActive(null)} />
      </div>
    </section>
  );
}

function LogPanel({ run, onClose }: { run: Run | null; onClose: () => void }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const live = run?.status === "running" || run?.status === "queued";

  // Auto-scroll to the newest line as the log grows.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.progress?.length, run?.id]);

  if (!run) {
    return (
      <aside className="log-panel empty">
        <p className="muted small">Select a run, or start an agent, to see its log here.</p>
      </aside>
    );
  }

  const lines = run.progress ?? [];

  return (
    <aside className="log-panel">
      <div className="log-head">
        <div className="log-title">
          <span className={`status-dot status-${run.status}`} />
          {agentLabel(run.agent)} run
          <span className={`badge status-${run.status}`}>
            {run.status}
            {live && <span className="live-pulse" />}
          </span>
        </div>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="log-meta muted small">
        Started {new Date(run.createdAt).toLocaleString()}
        {run.finishedAt && ` · Finished ${new Date(run.finishedAt).toLocaleString()}`}
      </div>

      <div className="log-body" ref={bodyRef}>
        {lines.length === 0 ? (
          <p className="muted small">{live ? "Waiting for the first log line…" : "No log output."}</p>
        ) : (
          lines.map((l, i) => (
            <div className="log-line" key={i}>
              {l}
            </div>
          ))
        )}
      </div>

      {(run.summary || run.result || run.error) && (
        <div className="log-foot">
          {run.status === "succeeded" && (
            <p className="notice small">
              Added {run.result?.added ?? 0} job{run.result?.added === 1 ? "" : "s"}
              {run.result?.updated ? `, updated ${run.result.updated}` : ""}.
              {run.summary ? ` ${run.summary}` : ""}
            </p>
          )}
          {run.status === "failed" && <p className="error small">{run.error}</p>}
        </div>
      )}
    </aside>
  );
}
