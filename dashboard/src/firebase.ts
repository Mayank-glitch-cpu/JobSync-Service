import { initializeApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

// The Firebase web config is fetched at runtime from the server's /api/config so
// the same build works across environments. These values are public, not secrets.
let auth: Auth | null = null;

export async function initFirebase(): Promise<Auth> {
  if (auth) return auth;
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`Failed to load /api/config (${res.status})`);
  const config = (await res.json()) as { apiKey: string; authDomain: string; projectId: string };
  if (!config.apiKey) throw new Error("Firebase config is not set on the server (FIREBASE_API_KEY).");
  const app = initializeApp(config);
  auth = getAuth(app);
  return auth;
}

export function getAuthOrThrow(): Auth {
  if (!auth) throw new Error("Firebase not initialized");
  return auth;
}
