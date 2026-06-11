// Automatic verification-code retrieval for the auto-apply flow.
//
// When an application form gates submission behind a "we emailed you a code"
// step, the agent used to stall and ask the user to read their inbox by hand.
// This module reads the applicant's OWN mailbox over IMAP (their account, their
// credentials), finds the just-arrived verification mail, extracts the numeric
// code, and hands it back so the apply flow can enter it without a human.
//
// Credentials come from env (never the profile JSON, which is stored remotely):
//   JOBSYNC_IMAP_USER      mailbox login (defaults to the personal-profile email)
//   JOBSYNC_IMAP_PASSWORD  app password / token  (REQUIRED — auto-fetch is off
//                          entirely when this is unset, so existing users who
//                          haven't opted in keep the manual ask)
//   JOBSYNC_IMAP_HOST      IMAP host (defaults derived from the user's domain)
//   JOBSYNC_IMAP_PORT      defaults 993
//   JOBSYNC_IMAP_TLS       "false" to disable implicit TLS (defaults true)

import { readPersonalProfile, type PersonalProfile } from "./personal-profile.js";

type ImapFlowCtor = typeof import("imapflow").ImapFlow;

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** Common provider IMAP hosts, derived from the login's domain. Falls back to
 *  `imap.<domain>` which is the near-universal convention for everyone else. */
function hostForDomain(domain: string): string {
  const d = domain.toLowerCase();
  if (d === "gmail.com" || d === "googlemail.com" || d.endsWith(".edu") || d.endsWith("asu.edu"))
    return "imap.gmail.com"; // Google Workspace (incl. most .edu) uses Gmail IMAP
  if (d === "outlook.com" || d === "hotmail.com" || d === "live.com" || d === "office365.com")
    return "outlook.office365.com";
  if (d === "yahoo.com") return "imap.mail.yahoo.com";
  if (d === "icloud.com" || d === "me.com") return "imap.mail.me.com";
  return `imap.${domain}`;
}

/** Resolve IMAP settings from env (+ personal profile for the default address).
 *  Returns null when auto-fetch is not configured, so the caller falls back to
 *  asking the user for the code. */
export async function resolveImapConfig(): Promise<ImapConfig | null> {
  const pass = process.env.JOBSYNC_IMAP_PASSWORD;
  if (!pass) return null; // not opted in — keep the manual path

  let user = process.env.JOBSYNC_IMAP_USER ?? "";
  if (!user) {
    const profile = await readPersonalProfile().catch(() => ({}) as Partial<PersonalProfile>);
    user = profile.email ?? "";
  }
  if (!user) return null;

  const domain = user.includes("@") ? user.split("@")[1]! : "";
  const host = process.env.JOBSYNC_IMAP_HOST || (domain ? hostForDomain(domain) : "");
  if (!host) return null;

  const port = Number(process.env.JOBSYNC_IMAP_PORT) || 993;
  const secure = process.env.JOBSYNC_IMAP_TLS !== "false";
  return { host, port, secure, user, pass };
}

// Strip MIME quoted-printable soft breaks and HTML so a code split across markup
// (e.g. <span>1</span><span>2</span> or a "=\r\n" wrap) is still readable.
function normalizeBody(raw: string): string {
  return raw
    .replace(/=\r?\n/g, "") // quoted-printable soft line break
    .replace(/=3D/gi, "=") // common QP-encoded '='
    .replace(/<[^>]+>/g, " ") // drop HTML tags
    .replace(/&nbsp;|&zwnj;|&#8203;/gi, " ")
    .replace(/\s+/g, " ");
}

// Pull the most plausible verification code out of subject/body text. Prefers a
// digit run that sits next to code-ish wording; falls back to a lone 6-digit run.
const CODE_NEAR_KEYWORD =
  /(?:verification|confirmation|security|one[\s-]*time|access|login|sign[\s-]*in|your|otp|2fa|mfa)[^0-9]{0,40}?(\d[\d\s-]{3,9}\d)|(\d[\d\s-]{3,9}\d)[^0-9]{0,20}?(?:is your|verification|confirmation|code)/i;
const SIX_DIGIT = /\b(\d{6})\b/;
const FOUR_TO_EIGHT = /\b(\d{4,8})\b/;

export function extractCode(text: string): string | null {
  const t = normalizeBody(text);
  for (const re of [CODE_NEAR_KEYWORD, SIX_DIGIT, FOUR_TO_EIGHT]) {
    const m = t.match(re);
    if (m) {
      const digits = (m[1] ?? m[2] ?? "").replace(/[\s-]/g, "");
      if (digits.length >= 4 && digits.length <= 8) return digits;
    }
  }
  return null;
}

let cachedCtor: ImapFlowCtor | null | undefined;
async function getImapFlow(): Promise<ImapFlowCtor | null> {
  if (cachedCtor !== undefined) return cachedCtor;
  try {
    cachedCtor = (await import("imapflow")).ImapFlow;
  } catch {
    cachedCtor = null; // dependency missing — degrade to manual entry
  }
  return cachedCtor;
}

/** One pass over the inbox: newest-first, only messages that arrived at/after
 *  `since`, returning the first extractable code. */
async function searchOnce(cfg: ImapConfig, since: Date): Promise<string | null> {
  const ImapFlow = await getImapFlow();
  if (!ImapFlow) return null;

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return null;
      // Newest first — the verification mail is the most recent arrival.
      const recent = uids.slice(-8).reverse();
      for (const uid of recent) {
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, envelope: true, source: true },
          { uid: true },
        );
        if (!msg) continue;
        const subject = msg.envelope?.subject ?? "";
        const source = msg.source ? msg.source.toString("utf8") : "";
        const code = extractCode(subject) ?? extractCode(source);
        if (code) return code;
      }
      return null;
    } finally {
      lock.release();
    }
  } catch {
    return null; // connection/auth failure — fall back to manual
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Poll the applicant's inbox for a verification code that arrived after the
 *  form was submitted. Returns the code, or null if auto-fetch is unconfigured
 *  or no code shows up within `timeoutMs`. Codes can take 10–60s to arrive, so
 *  we retry on an interval rather than reading once. */
export async function fetchEmailCode(opts: {
  since: Date;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<string | null> {
  const cfg = await resolveImapConfig();
  if (!cfg) return null;

  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const code = await searchOnce(cfg, opts.since);
    if (code) return code;
    if (Date.now() + pollMs >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

/** True when auto-fetch is configured (used to decide whether to even try). */
export async function emailCodeAutoEnabled(): Promise<boolean> {
  return (await resolveImapConfig()) !== null;
}
