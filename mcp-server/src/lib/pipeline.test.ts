import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory docs store so pipeline scoping can be tested without SQLite/Firestore.
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

const { upsertPipelineEntries, getPipelineGrouped, updateStatuses, readPipeline } = await import(
  "./pipeline.js"
);

beforeEach(() => docs.clear());

function jobFor(company: string) {
  return { positionTitle: "Engineer", company, applyLink: `https://x.test/${company}` };
}

describe("pipeline tenant isolation (scope = uid)", () => {
  it("keeps each user's pipeline separate", async () => {
    await upsertPipelineEntries([jobFor("AcmeA")], "userA");
    await upsertPipelineEntries([jobFor("AcmeB1"), jobFor("AcmeB2")], "userB");

    const a = await getPipelineGrouped(undefined, "userA");
    const b = await getPipelineGrouped(undefined, "userB");

    expect(a.summary.total).toBe(1);
    expect(b.summary.total).toBe(2);
    // userA cannot see userB's jobs
    const aCompanies = (a.byStatus.pending ?? []).map((e) => e.company);
    expect(aCompanies).toEqual(["AcmeA"]);
  });

  it("status updates only affect the scoped user", async () => {
    await upsertPipelineEntries([jobFor("Acme")], "userA");
    await upsertPipelineEntries([jobFor("Acme")], "userB");

    const aEntry = (await readPipeline("userA"))[0]!;
    await updateStatuses([{ id: aEntry.id, status: "applied" }], "userA");

    expect((await readPipeline("userA"))[0]!.status).toBe("applied");
    expect((await readPipeline("userB"))[0]!.status).toBe("pending");
  });

  it("defaults to the single-user 'default' scope when no uid is passed", async () => {
    await upsertPipelineEntries([jobFor("Solo")]);
    expect(docs.has("pipeline::default")).toBe(true);
  });
});
