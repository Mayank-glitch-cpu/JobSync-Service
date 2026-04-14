import { describe, expect, it } from "vitest";
import { isLikelyNonUSLocation, passesTitleFilter } from "./filter.js";

describe("isLikelyNonUSLocation", () => {
  it("flags obvious non-US cities", () => {
    expect(isLikelyNonUSLocation("London, United Kingdom")).toBe(true);
    expect(isLikelyNonUSLocation("Bangalore, India")).toBe(true);
    expect(isLikelyNonUSLocation("Remote - Europe")).toBe(true);
  });

  it("accepts US locations and lets ambiguous through", () => {
    expect(isLikelyNonUSLocation("San Francisco, CA")).toBe(false);
    expect(isLikelyNonUSLocation("Remote - US")).toBe(false);
    expect(isLikelyNonUSLocation("Remote")).toBe(false);
  });

  it("US positive override beats non-US token", () => {
    expect(isLikelyNonUSLocation("New York, US / London, UK")).toBe(false);
  });
});

describe("passesTitleFilter", () => {
  it("rejects senior-level titles", () => {
    expect(
      passesTitleFilter({ title: "Senior Software Engineer", location: "Remote - US" }),
    ).toBe(false);
  });

  it("accepts new grad SWE role", () => {
    expect(
      passesTitleFilter({ title: "Software Engineer, New Grad", location: "San Francisco, CA" }),
    ).toBe(true);
  });

  it("rejects EU-only role under usOnly", () => {
    expect(
      passesTitleFilter({ title: "AI Engineer", location: "Berlin, Germany" }),
    ).toBe(false);
  });

  it("honors custom include/exclude", () => {
    expect(
      passesTitleFilter(
        { title: "Product Manager", location: "NYC" },
        { include: ["product"], exclude: [] },
      ),
    ).toBe(true);
  });
});
