import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  apiFetch,
  fetchLiveFrame,
  previewSrc,
  TWEAKS,
  type Agent,
  type ProposedField,
  type Run,
} from "../api";

const AGENT_LABEL: Record<string, string> = {
  search: "Search",
  "auto-apply": "Auto-Apply",
};

function agentLabel(id: string): string {
  return AGENT_LABEL[id] ?? id;
}

// Statuses where the run is finished and polling should stop.
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
// While in one of these the apply browser is open, so the live pane should refresh.
const LIVE = new Set(["running", "queued", "awaiting_approval"]);

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

  // approve | discard | accept-all — the run's terminal-ish actions.
  async function decide(id: string, action: "approve" | "discard" | "accept-all") {
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

  // tweak | edit — revise one proposed answer in place; the run stays awaiting.
  async function reviseField(id: string, body: Record<string, unknown>, kind: "tweak" | "edit") {
    setError(null);
    try {
      const res = await apiFetch<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}/${kind}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setActive(res.run);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section>
      <h1>Agents</h1>
      <p className="muted">
        Run an agent and watch it work live on the right. Auto-Apply fills a job from your Pipeline —
        review and tweak the answers, then approve, or let it submit autonomously.
      </p>

      {error && <p className="error">{error}</p>}

      {active ? (
        <Console
          run={active}
          busy={busy}
          onDecide={decide}
          onRevise={reviseField}
          onClose={() => {
            stopPolling();
            setActive(null);
          }}
        />
      ) : (
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
                  <tr key={r.id} className="run-row" onClick={() => selectRun(r)}>
                    <td>{agentLabel(r.agent)}</td>
                    <td>
                      <span className={`badge status-${r.status}`}>{r.status.replace("_", " ")}</span>
                    </td>
                    <td className="muted">{r.result ? `+${r.result.added}` : r.error ? "error" : "—"}</td>
                    <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

// ── The 3-pane agent console (active run) ───────────────────────────────────────

function Console({
  run,
  busy,
  onDecide,
  onRevise,
  onClose,
}: {
  run: Run;
  busy: boolean;
  onDecide: (id: string, action: "approve" | "discard" | "accept-all") => void;
  onRevise: (id: string, body: Record<string, unknown>, kind: "tweak" | "edit") => Promise<void>;
  onClose: () => void;
}) {
  const live = LIVE.has(run.status);

  return (
    <div className="agent-console">
      <div className="console-bar">
        <div className="log-title">
          <span className={`status-dot status-${run.status}`} />
          {agentLabel(run.agent)}
          <span className={`badge status-${run.status}`}>
            {run.status.replace("_", " ")}
            {live && <span className="live-pulse" />}
          </span>
          {run.autonomous && <span className="badge">autonomous</span>}
        </div>
        <button className="link" onClick={onClose}>
          ← Back to runs
        </button>
      </div>

      <div className="console-grid">
        <div className="console-left">
          <JobMetaCard run={run} />
          <LogAndApprove run={run} busy={busy} onDecide={onDecide} onRevise={onRevise} />
        </div>
        <LiveBrowser run={run} />
      </div>
    </div>
  );
}

function JobMetaCard({ run }: { run: Run }) {
  const m = run.meta ?? {};
  const rows: Array<[string, string | undefined]> = [
    ["Company", run.company],
    ["Location", m.location],
    ["ATS", m.atsHint],
    ["Fields detected", m.totalFields != null ? String(m.totalFields) : undefined],
    ["Fit score", m.fitScore],
    ["Industry", m.industry],
    ["Tags", m.tags],
    ["Posted", m.datePosted],
  ];
  return (
    <div className="card job-meta-card">
      <h3>{run.jobTitle ?? "Application"}</h3>
      <dl className="meta-grid">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div className="meta-row" key={k}>
              <dt className="muted small">{k}</dt>
              <dd className="small">{v}</dd>
            </div>
          ))}
      </dl>
      {run.applyLink && (
        <a className="link small" href={run.applyLink} target="_blank" rel="noreferrer">
          Open application ↗
        </a>
      )}
    </div>
  );
}

function LogAndApprove({
  run,
  busy,
  onDecide,
  onRevise,
}: {
  run: Run;
  busy: boolean;
  onDecide: (id: string, action: "approve" | "discard" | "accept-all") => void;
  onRevise: (id: string, body: Record<string, unknown>, kind: "tweak" | "edit") => Promise<void>;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lines = run.progress ?? [];
  const live = LIVE.has(run.status);
  const awaiting = run.status === "awaiting_approval";

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.progress?.length, run.id]);

  return (
    <div className="card log-card">
      {awaiting && run.proposed && (
        <div className="approve-box">
          <div className="approve-head">
            <strong className="small">Review the agent's answers</strong>
            <span className="muted small">{run.proposed.filled.length} field(s)</span>
          </div>
          {run.proposed.unfilledRequired.length > 0 && (
            <p className="error small">
              {run.proposed.unfilledRequired.length} required field(s) couldn't be filled:{" "}
              {run.proposed.unfilledRequired.join(", ")}.
            </p>
          )}
          <div className="answers">
            {run.proposed.filled.map((f) => (
              <AnswerRow key={f.selector} runId={run.id} field={f} onRevise={onRevise} />
            ))}
          </div>
          <div className="approve-actions">
            <button onClick={() => onDecide(run.id, "approve")} disabled={busy}>
              {busy ? "Submitting…" : "Approve & submit"}
            </button>
            <button className="accept-all" onClick={() => onDecide(run.id, "accept-all")} disabled={busy}>
              Accept all
            </button>
            <button className="ghost" onClick={() => onDecide(run.id, "discard")} disabled={busy}>
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="log-subhead muted small">Activity log</div>
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
    </div>
  );
}

function AnswerRow({
  runId,
  field,
  onRevise,
}: {
  runId: string;
  field: ProposedField;
  onRevise: (id: string, body: Record<string, unknown>, kind: "tweak" | "edit") => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(field.value);

  useEffect(() => {
    setDraft(field.value);
  }, [field.value]);

  async function tweak(transform: string) {
    setPending(transform);
    await onRevise(runId, { selector: field.selector, transform }, "tweak");
    setPending(null);
  }

  async function saveEdit() {
    setPending("edit");
    await onRevise(runId, { selector: field.selector, value: draft }, "edit");
    setPending(null);
    setEditing(false);
  }

  return (
    <div className="answer-row">
      <div className="answer-label small">
        <span className="muted">{field.label}</span>
        {field.required && <span className="req">required</span>}
      </div>
      {editing ? (
        <div className="answer-edit">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
          <div className="tweak-hints">
            <button className="chip" onClick={saveEdit} disabled={pending !== null}>
              Save
            </button>
            <button className="chip ghost" onClick={() => setEditing(false)} disabled={pending !== null}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="answer-value small">{field.value || <span className="muted">(empty)</span>}</div>
          {field.editable && (
            <div className="tweak-hints">
              {TWEAKS.map((t) => (
                <button
                  key={t.id}
                  className="chip"
                  onClick={() => tweak(t.id)}
                  disabled={pending !== null}
                >
                  {pending === t.id ? "…" : t.label}
                </button>
              ))}
              <button className="chip ghost" onClick={() => setEditing(true)} disabled={pending !== null}>
                Edit
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LiveBrowser({ run }: { run: Run }) {
  const [frame, setFrame] = useState<string | undefined>(undefined);
  const live = LIVE.has(run.status);
  const fallback = run.previews?.length ? previewSrc(run.previews[run.previews.length - 1]) : undefined;

  useEffect(() => {
    if (!live) {
      setFrame(undefined);
      return;
    }
    let cancelled = false;
    let timer: number;
    const tick = async () => {
      const f = await fetchLiveFrame(run.id).catch(() => undefined);
      if (!cancelled) {
        if (f) setFrame(f);
        timer = window.setTimeout(tick, 800);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [run.id, live]);

  const src = frame ?? fallback;
  const caption = live ? "Live — agent is applying" : run.previews?.[run.previews.length - 1]?.caption;

  return (
    <div className="card live-browser">
      <div className="live-head">
        <span className="muted small">Browser</span>
        {live && <span className="live-pulse" />}
      </div>
      <div className="live-stage">
        {src ? (
          <img src={src} alt={caption ?? "browser"} />
        ) : (
          <p className="muted small">{live ? "Opening the application form…" : "No preview captured."}</p>
        )}
      </div>
      {caption && <div className="muted small live-caption">{caption}</div>}
    </div>
  );
}
