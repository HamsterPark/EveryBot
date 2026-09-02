import { describe, it, expect } from "vitest";
import { parseAddressList, isAllowedAddress } from "./allowlist.js";

describe("allowlist", () => {
  it("parses comma-separated lists, trimming and lowercasing", () => {
    expect(parseAddressList(" A@x.com, b@y.org ,, ")).toEqual(["a@x.com", "b@y.org"]);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
  });

  it("allows only the fallback (owner) address when no list is configured", () => {
    expect(isAllowedAddress("Me@QQ.com", [], "me@qq.com")).toBe(true);
    expect(isAllowedAddress("other@qq.com", [], "me@qq.com")).toBe(false);
    expect(isAllowedAddress(null, [], "me@qq.com")).toBe(false);
    expect(isAllowedAddress("", [], "me@qq.com")).toBe(false);
  });

  it("treats a configured list as authoritative", () => {
    expect(isAllowedAddress("friend@x.com", ["friend@x.com"], "me@qq.com")).toBe(true);
    expect(isAllowedAddress("FRIEND@x.com", ["friend@x.com"], "me@qq.com")).toBe(true);
    expect(isAllowedAddress("me@qq.com", ["friend@x.com"], "me@qq.com")).toBe(false);
  });

  it("never allows anything when nothing is configured at all", () => {
    expect(isAllowedAddress("anyone@x.com", [], "")).toBe(false);
  });
});
