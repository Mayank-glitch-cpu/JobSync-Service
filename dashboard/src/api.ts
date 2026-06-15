import { getAuthOrThrow } from "./firebase";

// Thin fetch wrapper that attaches the current user's Firebase ID token. Every
// /api/* call goes through here so the server can verify and scope to the user.
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const user = getAuthOrThrow().currentUser;
  const headers = new Headers(init.headers);
  if (user) headers.set("authorization", `Bearer ${await user.getIdToken()}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      detail = ((await res.json()) as { error?: string }).error ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// ── API response types ────────────────────────────────────────────────────────

export interface PipelineEntry {
  id: string;
  positionTitle: string;
  company: string;
  location: string;
  applyLink: string;
  datePosted: string;
  industry: string;
  tags: string;
  fitScore: string;
  status: string;
  appliedAt: string;
  updatedAt: string;
  notes: string;
}

export interface PipelineResponse {
  summary: Record<string, number>;
  byStatus: Record<string, PipelineEntry[]>;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  status: string;
}

export interface PreviewFrame {
  stage: "inspect" | "filled" | "submitted" | "error";
  caption: string;
  url?: string;
  base64?: string;
  at: string;
}

export interface ProposedField {
  selector: string;
  label: string;
  value: string;
  type: string;
  required: boolean;
  /** AI-composed open text — the console offers tweak buttons for these. */
  editable: boolean;
}

/** A required question the agent couldn't answer from the profile — the console
 *  asks the user, and the answer is saved to per-user Q&A memory. */
export interface NeededInput {
  selector: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
}

export interface RunMeta {
  location?: string;
  datePosted?: string;
  industry?: string;
  tags?: string;
  fitScore?: string;
  atsHint?: string;
  totalFields?: number;
}

export interface Run {
  id: string;
  agent: string;
  status: string;
  createdAt: string;
  finishedAt?: string;
  progress?: string[];
  result?: { added: number; updated: number };
  summary?: string;
  error?: string;
  // Auto-Apply
  previews?: PreviewFrame[];
  proposed?: { filled: ProposedField[]; unfilledRequired: string[] };
  needsInput?: NeededInput[];
  applyLink?: string;
  jobId?: string;
  company?: string;
  jobTitle?: string;
  meta?: RunMeta;
  autonomous?: boolean;
  needsEmailCode?: boolean;
  needsCaptcha?: boolean;
}

/** The tweak transforms the console exposes as one-click buttons. */
export const TWEAKS: Array<{ id: string; label: string }> = [
  { id: "formal", label: "Make formal" },
  { id: "shorten", label: "Shorten" },
  { id: "humanize", label: "Humanize" },
  { id: "informal", label: "Make informal" },
  { id: "more-facts", label: "Add facts" },
];

/** Render a preview frame to an <img>-ready src (GCS url or inline base64). */
export function previewSrc(p: PreviewFrame): string | undefined {
  if (p.url) return p.url;
  if (p.base64) return `data:image/png;base64,${p.base64}`;
  return undefined;
}

/** Fetch the latest live-browser frame for a run (or undefined when none yet). */
export async function fetchLiveFrame(runId: string): Promise<string | undefined> {
  const user = getAuthOrThrow().currentUser;
  const headers = new Headers();
  if (user) headers.set("authorization", `Bearer ${await user.getIdToken()}`);
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/live`, { headers });
  if (res.status !== 200) return undefined;
  const data = (await res.json()) as { url?: string; base64?: string };
  if (data.url) return data.url;
  if (data.base64) return `data:image/png;base64,${data.base64}`;
  return undefined;
}

export interface Roles {
  detected: string[];
  custom: string[];
  excluded: string[];
}

export interface Personal {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  country?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  twitterUrl?: string;
  scholarUrl?: string;
  otherUrls?: string;
  // Work authorization
  workAuthorization?: string;
  requiresSponsorship?: boolean;
  // Voluntary EEO self-identification (all optional)
  gender?: string;
  pronouns?: string;
  ethnicity?: string;
  veteranStatus?: string;
  disabilityStatus?: string;
}

export interface Profile {
  roles: Roles;
  activeRoles: string[];
  skills: string;
  experience: string;
  projects: string;
  personal: Personal;
  hasResume: boolean;
}

/** Read a File as base64 (no data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
