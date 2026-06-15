import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, fileToBase64, type Personal, type Profile as ProfileT } from "../api";

// Typeform-style, one-step-at-a-time onboarding. Collects everything Auto-Apply
// needs that the resume alone can't supply: contact, work authorization, social
// links, and (voluntary) EEO self-identification. Saves through the existing
// /api/profile + /api/profile/resume endpoints — no new server routes.

const GENDER_OPTIONS = ["Male", "Female", "Non-binary", "Decline to self-identify"];
const ETHNICITY_OPTIONS = [
  "Asian",
  "White",
  "Black or African American",
  "Hispanic or Latino",
  "Native American or Alaska Native",
  "Native Hawaiian or Pacific Islander",
  "Two or More Races",
  "Decline to self-identify",
];
const YESNO_DECLINE = ["Yes", "No", "Decline to self-identify"];
const WORK_AUTH_OPTIONS = [
  "US Citizen",
  "Green Card",
  "H1B Visa",
  "OPT",
  "CPT",
  "TN Visa",
  "Other",
];

export default function Onboarding() {
  const navigate = useNavigate();
  const [personal, setPersonal] = useState<Personal>({});
  const [hasResume, setHasResume] = useState(false);
  const [step, setStep] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ProfileT>("/api/profile")
      .then((p) => {
        setPersonal(p.personal ?? {});
        setHasResume(p.hasResume);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const set = (key: keyof Personal, value: string | boolean) =>
    setPersonal((prev) => ({ ...prev, [key]: value }));

  async function onResume(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const base64 = await fileToBase64(file);
      const p = await apiFetch<ProfileT>("/api/profile/resume", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, base64 }),
      });
      setPersonal((prev) => ({ ...(p.personal ?? {}), ...prev }));
      setHasResume(true);
      setNotice("Resume uploaded and parsed — it'll be attached to your applications.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  const text = (key: keyof Personal, label: string, placeholder = "") => (
    <label className="ob-field" key={key}>
      <span>{label}</span>
      <input
        value={(personal[key] as string) ?? ""}
        placeholder={placeholder}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );

  const select = (key: keyof Personal, label: string, options: string[]) => (
    <label className="ob-field" key={key}>
      <span>{label}</span>
      <select value={(personal[key] as string) ?? ""} onChange={(e) => set(key, e.target.value)}>
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );

  const steps: Array<{ title: string; subtitle: string; body: ReactNode }> = useMemo(
    () => [
      {
        title: "Upload your resume",
        subtitle:
          "We parse it into target roles + skills, and attach the original file to your applications.",
        body: (
          <div className="ob-resume">
            <p className="muted">{hasResume ? "✓ A resume is on file." : "No resume uploaded yet."}</p>
            <label className="file-btn">
              {uploading ? "Parsing…" : hasResume ? "Replace resume" : "Upload resume (PDF / DOCX / TXT)"}
              <input
                type="file"
                accept=".pdf,.docx,.txt,.md"
                onChange={onResume}
                disabled={uploading}
                hidden
              />
            </label>
          </div>
        ),
      },
      {
        title: "About you",
        subtitle: "The basics every application asks for.",
        body: (
          <div className="ob-grid">
            {text("firstName", "First name")}
            {text("lastName", "Last name")}
            {text("email", "Email")}
            {text("phone", "Phone")}
          </div>
        ),
      },
      {
        title: "Location & work authorization",
        subtitle: "Used for location fields and the standard eligibility questions.",
        body: (
          <div className="ob-grid">
            {text("city", "City")}
            {text("state", "State / Province")}
            {text("country", "Country", "United States")}
            {select("workAuthorization", "Work authorization", WORK_AUTH_OPTIONS)}
            <label className="ob-field ob-check">
              <input
                type="checkbox"
                checked={Boolean(personal.requiresSponsorship)}
                onChange={(e) => set("requiresSponsorship", e.target.checked)}
              />
              <span>I will require visa sponsorship now or in the future</span>
            </label>
          </div>
        ),
      },
      {
        title: "Your links",
        subtitle: "Profiles recruiters and forms ask for. Leave any blank.",
        body: (
          <div className="ob-grid">
            {text("linkedinUrl", "LinkedIn", "https://linkedin.com/in/…")}
            {text("githubUrl", "GitHub", "https://github.com/…")}
            {text("twitterUrl", "X (Twitter)", "https://x.com/…")}
            {text("scholarUrl", "Google Scholar", "https://scholar.google.com/…")}
            {text("portfolioUrl", "Portfolio / website")}
            {text("otherUrls", "Other links", "comma-separated")}
          </div>
        ),
      },
      {
        title: "Voluntary self-identification",
        subtitle:
          "Entirely optional. US applications ask these for EEO reporting — pre-filling them saves time. You can decline any.",
        body: (
          <div className="ob-grid">
            {select("gender", "Gender", GENDER_OPTIONS)}
            {text("pronouns", "Pronouns", "e.g. she/her")}
            {select("ethnicity", "Race / Ethnicity", ETHNICITY_OPTIONS)}
            {select("veteranStatus", "Protected veteran status", YESNO_DECLINE)}
            {select("disabilityStatus", "Disability status", YESNO_DECLINE)}
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [personal, hasResume, uploading],
  );

  const last = step === steps.length - 1;

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch("/api/profile", { method: "PUT", body: JSON.stringify({ personal }) });
      navigate("/agents");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function next() {
    if (last) return finish();
    // Persist progress as we go so a refresh doesn't lose it.
    setPersonal((p) => p);
    apiFetch("/api/profile", { method: "PUT", body: JSON.stringify({ personal }) }).catch(() => {});
    setStep((s) => Math.min(s + 1, steps.length - 1));
    setNotice(null);
  }

  const current = steps[step];

  return (
    <div className="onboarding">
      <div className="ob-card">
        <div className="ob-progress">
          {steps.map((_, i) => (
            <span key={i} className={`ob-dot ${i <= step ? "on" : ""}`} />
          ))}
        </div>
        <div className="ob-step-count muted small">
          Step {step + 1} of {steps.length}
        </div>

        <h1>{current.title}</h1>
        <p className="muted">{current.subtitle}</p>

        {notice && <p className="notice">{notice}</p>}
        {error && <p className="error">{error}</p>}

        <div className="ob-body">{current.body}</div>

        <div className="ob-actions">
          {step > 0 ? (
            <button className="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))}>
              ← Back
            </button>
          ) : (
            <button className="link" onClick={() => navigate("/agents")}>
              Skip for now
            </button>
          )}
          <button onClick={next} disabled={saving || uploading}>
            {last ? (saving ? "Saving…" : "Finish") : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}
