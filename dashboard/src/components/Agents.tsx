import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, previewSrc, type Agent, type Run } from "../api";

const AGENT_LABEL: Record<string, string> = {
  search: "Search",
  "auto-apply": "Auto-Apply",
};

function agentLabel(id: string): string {
  return AGENT_LABEL[id] ?? id;
}

// Statuses where the run is finished and polling should stop.
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export default function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [active, setActive] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

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

  function stopPolling() {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
  }

  function pollRun(id: string) {
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      try {
        const run = await apiFetch<Run>(`/api/runs/${encodeURIComponent(id)}`);
        setActive((cur) => (cur && cur.id === id ? run : cur));
        // Stop on terminal OR awaiting_approval (now it's the user's move).
        if (TERMINAL.has(run.status) || run.status === "awaiting_approval") {
          stopPolling();
          await refresh();
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
  }

  async function selectRun(r: Run) {
    setActive(r);
    stopPolling();
    try {
      const full = await apiFetch<Run>(`/api/runs/${encodeURIComponent(r.id)}`);
      setActive(full);
      if (full.status === "running" || full.status === "queued") pollRun(full.id);
    } catch {
      /* row data is enough to show something */
    }
  }

  useEffect(() => {
    refresh();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep link from the Pipeline "Auto-Apply" button: ?run=<id> selects + follows it.
  useEffect(() => {
    const id = searchParams.get("run");
    if (id && active?.id !== id) {
      void selectRun({ id } as Run);
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function run(agentId: string) {
    setError(null);
    try {
      const res = await apiFetch<{ run: Run; message?: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ agent: agentId, params: { lookbackHours: 48 } }),
      });
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

  async function decide(id: string, action: "approve" | "discard") {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
      });
      setActive(res.run);
      if (res.run.status === "running") pollRun(res.run.id);
      else await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Agents</h1>
      <p className="muted">
        Run an agent and watch its live log on the right. Auto-Apply fills a job from your Pipeline and
        shows a preview — nothing is submitted until you approve it.
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
                {a.id === "auto-apply" ? (
                  <span className="muted small">Start from a job in your Pipeline →</span>
                ) : (
                  <button onClick={() => run(a.id)} disabled={a.status === "unavailable"}>
                    Run {a.name}
                  </button>
                )}
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
                      <span className={`badge status-${r.status}`}>{r.status.replace("_", " ")}</span>
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

        <LogPanel run={active} busy={busy} onDecide={decide} onClose={() => setActive(null)} />
      </div>
    </section>
  );
}

function LogPanel({
  run,
  busy,
  onDecide,
  onClose,
}: {
  run: Run | null;
  busy: boolean;
  onDecide: (id: string, action: "approve" | "discard") => void;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const live = run?.status === "running" || run?.status === "queued";

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.progress?.length, run?.id]);

  if (!run) {
    return (
      <aside className="log-panel empty">
        <p className="muted small">Select a run, or start an agent, to see its log and preview here.</p>
      </aside>
    );
  }

  const lines = run.progress ?? [];
  const latestPreview = run.previews?.[run.previews.length - 1];
  const previewImg = latestPreview ? previewSrc(latestPreview) : undefined;
  const awaiting = run.status === "awaiting_approval";

  return (
    <aside className="log-panel">
      <div className="log-head">
        <div className="log-title">
          <span className={`status-dot status-${run.status}`} />
          {agentLabel(run.agent)} run
          <span className={`badge status-${run.status}`}>
            {run.status.replace("_", " ")}
            {live && <span className="live-pulse" />}
          </span>
        </div>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="log-meta muted small">
        {run.jobTitle ? `${run.jobTitle}${run.company ? ` · ${run.company}` : ""} · ` : ""}
        Started {new Date(run.createdAt).toLocaleString()}
      </div>

      {previewImg && (
        <figure className="preview-shot">
          <img src={previewImg} alt={latestPreview?.caption ?? "preview"} />
          <figcaption className="muted small">{latestPreview?.caption}</figcaption>
        </figure>
      )}

      {awaiting && run.proposed && (
        <div className="approve-box">
          {run.proposed.unfilledRequired.length > 0 && (
            <p className="error small">
              {run.proposed.unfilledRequired.length} required field(s) couldn't be filled:{" "}
              {run.proposed.unfilledRequired.join(", ")}. Review before submitting.
            </p>
          )}
          <details className="proposed">
            <summary className="small">{run.proposed.filled.length} field(s) filled — review</summary>
            <ul className="proposed-list">
              {run.proposed.filled.map((f, i) => (
                <li key={i} className="small">
                  <span className="muted">{f.label}:</span> {f.value}
                </li>
              ))}
            </ul>
          </details>
          <div className="approve-actions">
            <button onClick={() => onDecide(run.id, "approve")} disabled={busy}>
              {busy ? "Submitting…" : "Approve & submit"}
            </button>
            <button className="ghost" onClick={() => onDecide(run.id, "discard")} disabled={busy}>
              Discard
            </button>
          </div>
        </div>
      )}

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
              {run.summary ??
                `Added ${run.result?.added ?? 0} job${run.result?.added === 1 ? "" : "s"}${
                  run.result?.updated ? `, updated ${run.result.updated}` : ""
                }.`}
            </p>
          )}
          {run.status === "failed" && <p className="error small">{run.error}</p>}
        </div>
      )}
    </aside>
  );
}
