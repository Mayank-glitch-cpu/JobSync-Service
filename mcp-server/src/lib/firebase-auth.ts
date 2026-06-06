// Firebase Auth verification for the dashboard's /api/* routes. The dashboard
// signs users in client-side (email/password) and sends the Firebase ID token as
// `Authorization: Bearer <idToken>`; here we verify it with firebase-admin and
// derive the user. Passwords never touch this server.
//
// firebase-admin is imported lazily (mirrors lib/gcs.ts / firestore backend) and
// uses Application Default Credentials on Cloud Run — no key file needed.

import type { IncomingMessage } from "node:http";
import { getStore } from "./store/index.js";

export interface AuthUser {
  uid: string;
  email: string | null;
}

/** Thrown when a request lacks a valid Firebase token. Mapped to HTTP 401. */
export class AuthError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

type AdminAuth = { verifyIdToken(token: string): Promise<{ uid: string; email?: string }> };
interface AdminModule {
  apps: unknown[];
  initializeApp(opts: { projectId?: string }): unknown;
  auth(app: unknown): AdminAuth;
}
let authPromise: Promise<AdminAuth> | null = null;

function projectId(): string | undefined {
  return process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIRESTORE_PROJECT_ID;
}

async function getAuth(): Promise<AdminAuth> {
  if (!authPromise) {
    authPromise = (async () => {
      // firebase-admin is CJS; under ESM its API lives on the default export.
      const mod = (await import("firebase-admin")) as unknown as { default?: AdminModule } & AdminModule;
      const admin = mod.default ?? mod;
      const app = admin.apps.length ? admin.apps[0] : admin.initializeApp({ projectId: projectId() });
      return admin.auth(app);
    })();
  }
  return authPromise;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

/** Verify a raw Firebase ID token. Throws AuthError if invalid. */
export async function verifyToken(idToken: string): Promise<AuthUser> {
  try {
    const decoded = await (await getAuth()).verifyIdToken(idToken);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch {
    throw new AuthError("invalid or expired token");
  }
}

/**
 * Resolve the authenticated user for a request, or throw AuthError. The uid is
 * always taken from the verified token — never from client-supplied input — which
 * is the tenant-isolation invariant for every /api/* route.
 */
export async function requireUser(req: IncomingMessage): Promise<AuthUser> {
  const token = bearerToken(req);
  if (!token) throw new AuthError("missing bearer token");
  return verifyToken(token);
}

/** Create or refresh the user's record in the docs store (`users/<uid>`). */
export async function upsertUser(user: AuthUser): Promise<void> {
  const store = await getStore();
  const existingRaw = await store.docs.readDoc("users", user.uid);
  const existing = existingRaw ? (JSON.parse(existingRaw) as Record<string, unknown>) : {};
  const now = new Date().toISOString();
  await store.docs.writeDoc(
    "users",
    user.uid,
    JSON.stringify({
      uid: user.uid,
      email: user.email,
      createdAt: existing.createdAt ?? now,
      lastSeenAt: now,
    }),
  );
}
