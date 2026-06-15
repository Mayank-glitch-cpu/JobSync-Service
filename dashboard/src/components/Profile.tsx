import { useEffect, useState, type ChangeEvent } from "react";
import { apiFetch, fileToBase64, type Personal, type Profile as ProfileT } from "../api";

export default function Profile() {
  const [profile, setProfile] = useState<ProfileT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [rolesText, setRolesText] = useState("");
  const [personal, setPersonal] = useState<Personal>({});

  async function load() {
    try {
      const p = await apiFetch<ProfileT>("/api/profile");
      setProfile(p);
      setRolesText(p.activeRoles.join(", "));
      setPersonal(p.personal ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

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
      setProfile(p);
      setRolesText(p.activeRoles.join(", "));
      setNotice("Resume parsed — review your roles and skills below.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function save() {
    setError(null);
    setNotice(null);
    try {
      const roles = rolesText.split(",").map((r) => r.trim()).filter(Boolean);
      const p = await apiFetch<ProfileT>("/api/profile", {
        method: "PUT",
        body: JSON.stringify({ roles, personal, skills: profile?.skills }),
      });
      setProfile(p);
      setNotice("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!profile && !error) return <p className="muted">Loading profile…</p>;

  const field = (key: keyof Personal, label: string) => (
    <label>
      {label}
      <input
        value={(personal[key] as string) ?? ""}
        onChange={(e) => setPersonal({ ...personal, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <section>
      <h1>Profile</h1>
      <p className="muted">
        Upload your resume — JobSync structures it into target roles and skills that drive the Search agent.
      </p>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Resume</h3>
        <p className="muted">{profile?.hasResume ? "A resume is on file." : "No resume uploaded yet."}</p>
        <label className="file-btn">
          {uploading ? "Parsing…" : "Upload resume (PDF / DOCX / TXT)"}
          <input type="file" accept=".pdf,.docx,.txt,.md" onChange={onResume} disabled={uploading} hidden />
        </label>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Target roles</h3>
        <p className="muted">Comma-separated. The Search agent looks for these.</p>
        <input value={rolesText} onChange={(e) => setRolesText(e.target.value)} placeholder="Backend Engineer, ML Engineer" />
      </div>

      {profile?.skills && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3>Skills</h3>
          <pre className="muted skills-pre">{profile.skills}</pre>
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Contact (used for auto-apply later)</h3>
        <div className="grid2">
          {field("firstName", "First name")}
          {field("lastName", "Last name")}
          {field("email", "Email")}
          {field("phone", "Phone")}
          {field("city", "City")}
          {field("state", "State")}
          {field("linkedinUrl", "LinkedIn URL")}
          {field("githubUrl", "GitHub URL")}
        </div>
      </div>

      <button onClick={save}>Save profile</button>
    </section>
  );
}
