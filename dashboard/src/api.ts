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
}
