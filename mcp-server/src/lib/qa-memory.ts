// Per-user application Q&A memory. When Auto-Apply hits a required question it can
// neither map from the profile nor confidently compose, it asks the user. The
// answer is saved here keyed by a normalized question label, so the next time the
// same question shows up on any form it's filled automatically and the user is
// never asked twice.

import { getStore } from "./store/index.js";
import { currentScope } from "./run-context.js";

const NS = "profile";
const FILE = "qa-memory.json";

function scopeDefault(): string {
  return currentScope() ?? "default";
}

function docId(scope: string): string {
  return scope === "default" ? FILE : `${scope}__${FILE}`;
}

/** Normalize a field label for matching: lowercase, strip markers, collapse space. */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[*:?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RememberedAnswer {
  /** The original (un-normalized) label, for display. */
  label: string;
  value: string;
  updatedAt: string;
}

export type QaMemory = Record<string, RememberedAnswer>;

export async function readQaMemory(scope: string = scopeDefault()): Promise<QaMemory> {
  const raw = await (await getStore()).docs.readDoc(NS, docId(scope));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as QaMemory;
  } catch {
    return {};
  }
}

/** Look up a remembered answer by (un-normalized) label; undefined when absent. */
export async function lookupAnswer(
  label: string,
  scope: string = scopeDefault(),
): Promise<string | undefined> {
  const mem = await readQaMemory(scope);
  return mem[normalizeLabel(label)]?.value;
}

/** Persist (merge) a batch of answered questions into the user's Q&A memory. */
export async function rememberAnswers(
  answers: Array<{ label: string; value: string }>,
  scope: string = scopeDefault(),
): Promise<void> {
  const filtered = answers.filter((a) => a.label?.trim() && a.value?.trim());
  if (filtered.length === 0) return;
  const mem = await readQaMemory(scope);
  const now = new Date().toISOString();
  for (const a of filtered) {
    mem[normalizeLabel(a.label)] = { label: a.label, value: a.value, updatedAt: now };
  }
  await (await getStore()).docs.writeDoc(NS, docId(scope), JSON.stringify(mem, null, 2));
}
