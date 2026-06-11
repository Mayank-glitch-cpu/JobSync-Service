import { describe, it, expect } from "vitest";
import { extractCode } from "./email-code.js";

describe("extractCode", () => {
  it("pulls a 6-digit code from a typical subject", () => {
    expect(extractCode("Your verification code is 482913")).toBe("482913");
  });

  it("reads a code that precedes the keyword", () => {
    expect(extractCode("294510 is your one-time passcode")).toBe("294510");
  });

  it("handles HTML-wrapped bodies", () => {
    expect(
      extractCode("<p>Enter this security code:</p><b>7 3 1 9 0 4</b>"),
    ).toBe("731904");
  });

  it("decodes quoted-printable soft breaks", () => {
    expect(extractCode("Your login code is 12=\r\n3456 — expires soon")).toBe("123456");
  });

  it("accepts a lone 4-digit code", () => {
    expect(extractCode("Confirm with 4821 to continue")).toBe("4821");
  });

  it("returns null when there is no plausible code", () => {
    expect(extractCode("Thanks for applying! We received your application.")).toBeNull();
  });

  it("ignores overly long digit runs (phone/IDs) without code wording", () => {
    expect(extractCode("Ref 1234567890123 logged")).toBeNull();
  });
});
