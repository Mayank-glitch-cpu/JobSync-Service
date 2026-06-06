import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { requireUser, AuthError } from "./firebase-auth.js";

function reqWith(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("requireUser auth guard", () => {
  it("rejects a request with no Authorization header", async () => {
    await expect(requireUser(reqWith({}))).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a non-Bearer Authorization header", async () => {
    await expect(requireUser(reqWith({ authorization: "Basic abc" }))).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects an empty Bearer token", async () => {
    await expect(requireUser(reqWith({ authorization: "Bearer " }))).rejects.toBeInstanceOf(AuthError);
  });
});
