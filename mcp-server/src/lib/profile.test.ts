import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory docs store so profile scoping can be tested without SQLite/Firestore.
const docs = new Map<string, string>();
const key = (ns: string, id: string) => `${ns}::${id}`;

vi.mock("./store/index.js", () => ({
  getStore: async () => ({
    backend: "local",
    docs: {
      async readDoc(ns: string, id: string) {
        return docs.get(key(ns, id)) ?? null;
      },
      async writeDoc(ns: string, id: string, body: string) {
        docs.set(key(ns, id), body);
      },
      async deleteDoc(ns: string, id: string) {
        docs.delete(key(ns, id));
      },
      async listDocs() {
        return [];
      },
    },
  }),
}));

const { readRoles, writeRoles, readProfileFile, writeProfileFile } = await import("./profile.js");
const { runWithScope } = await import("./run-context.js");

beforeEach(() => docs.clear());

describe("profile tenant isolation (scope = uid)", () => {
  it("keeps each user's roles and skills separate", async () => {
    await writeRoles({ detected: ["Backend Engineer"], custom: [], excluded: [] }, "userA");
    await writeRoles({ detected: ["ML Engineer"], custom: [], excluded: [] }, "userB");
    await writeProfileFile("skills", "Go, Postgres", "userA");

    expect((await readRoles("userA")).detected).toEqual(["Backend Engineer"]);
    expect((await readRoles("userB")).detected).toEqual(["ML Engineer"]);
    expect(await readProfileFile("skills", "userA")).toBe("Go, Postgres");
    expect(await readProfileFile("skills", "userB")).toBe(""); // not leaked
  });

  it("uses the historical bare key for the default scope", async () => {
    await writeRoles({ detected: ["X"], custom: [], excluded: [] }, "default");
    expect(docs.has("profile::roles.json")).toBe(true);
    expect(docs.has("profile::default__roles.json")).toBe(false);
  });
});

describe("run-context ambient scope", () => {
  it("writes/reads under the run's uid when no explicit scope is passed", async () => {
    await runWithScope("userZ", async () => {
      await writeRoles({ detected: ["Zeta"], custom: [], excluded: [] });
    });
    // Stored under userZ, not default.
    expect(docs.has("profile::userZ__roles.json")).toBe(true);
    expect((await readRoles("userZ")).detected).toEqual(["Zeta"]);
    expect((await readRoles("default")).detected).toEqual([]);
  });
});
