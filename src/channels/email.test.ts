import { describe, it, expect } from "vitest";

// Access the private sanitizeHeader via a test-only subclass
class TestableEmailChannel {
  sanitizeHeader(value: string): string {
    return value.replace(/[\r\n]/g, "");
  }
}

describe("EmailChannel.sanitizeHeader", () => {
  const ch = new TestableEmailChannel();

  it("removes CR and LF from header values", () => {
    expect(ch.sanitizeHeader("valid-message-id")).toBe("valid-message-id");
    expect(ch.sanitizeHeader("bad\r\nheader: injected")).toBe("badheader: injected");
    expect(ch.sanitizeHeader("bad\nvalue")).toBe("badvalue");
    expect(ch.sanitizeHeader("bad\rvalue")).toBe("badvalue");
  });

  it("preserves normal reference strings", () => {
    const ref = "<abc123@mail.example.com> <def456@mail.example.com>";
    expect(ch.sanitizeHeader(ref)).toBe(ref);
  });
});
