import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, type PipelineEntry, type PipelineResponse, type Run } from "../api";

const COLUMNS = ["pending", "applied", "interviewing", "offer", "rejected", "withdrawn"] as const;
const STATUS_OPTIONS = COLUMNS;

export default function Pipeline() {
  const [data, setData] = useState<PipelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const navigate = useNavigate();

  async function refresh() {
    try {
      setData(await apiFetch<PipelineResponse>("/api/pipeline"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Start an Auto-Apply preview run for one job, then jump to the Agents page
  // where the live log + filled-form preview render and the approve gate lives.
  async function autoApply(entry: PipelineEntry) {
    setError(null);
    setApplying(entry.id);
    try {
      const res = await apiFetch<{ run: Run }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          agent: "auto-apply",
          params: {
            jobId: entry.id,
            applyLink: entry.applyLink,
            company: entry.company,
            jobTitle: entry.positionTitle,
          },
        }),
      });
      navigate(`/agents?run=${encodeURIComponent(res.run.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(null);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function changeStatus(entry: PipelineEntry, status: string) {
    try {
      await apiFetch(`/api/pipeline/${encodeURIComponent(entry.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading pipeline…</p>;

  const total = data.summary.total ?? 0;

  return (
    <section>
      <h1>Pipeline</h1>
      <p className="muted">
        {total === 0
          ? "No jobs yet. Run the Search agent to start filling your pipeline."
          : `${total} job${total === 1 ? "" : "s"} across your pipeline.`}
      </p>

      <div className="board">
        {COLUMNS.map((col) => {
          const items = data.byStatus[col] ?? [];
          return (
            <div className="column" key={col}>
              <div className="column-head">
                <span className="col-title">{col}</span>
                <span className="badge">{items.length}</span>
              </div>
              {items.map((entry) => (
                <div className="job-card" key={entry.id}>
                  <div className="job-title">{entry.positionTitle}</div>
                  <div className="muted">{entry.company}</div>
                  {entry.location && <div className="muted small">{entry.location}</div>}
                  <div className="job-actions">
                    {entry.applyLink && (
                      <a href={entry.applyLink} target="_blank" rel="noreferrer" className="link">
                        Open
                      </a>
                    )}
                    <select value={entry.status} onChange={(e) => changeStatus(entry, e.target.value)}>
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  {col === "pending" && entry.applyLink && (
                    <button
                      className="apply-btn"
                      onClick={() => autoApply(entry)}
                      disabled={applying === entry.id}
                    >
                      {applying === entry.id ? "Starting…" : "Auto-Apply"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
