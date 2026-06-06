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
