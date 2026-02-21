import { describe, it, expect } from "vitest";
import { ApprovalManager } from "./approval.js";

describe("ApprovalManager", () => {
  it("add returns a UUID-formatted id", () => {
    const mgr = new ApprovalManager();
    const id = mgr.add("file.write", { path: "a.txt", content: "hello" });
    // UUID v4 pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("list returns pending items", () => {
    const mgr = new ApprovalManager();
    mgr.add("file.write", { path: "a.txt" });
    expect(mgr.list()).toHaveLength(1);
  });

  it("approve removes item and returns it", () => {
    const mgr = new ApprovalManager();
    const id = mgr.add("file.delete", { path: "b.txt" });
    const p = mgr.approve(id);
    expect(p).not.toBeNull();
    expect(p?.tool).toBe("file.delete");
    expect(mgr.list()).toHaveLength(0);
  });

  it("approve returns null for unknown id", () => {
    const mgr = new ApprovalManager();
    expect(mgr.approve("nonexistent")).toBeNull();
  });

  it("reject removes item and returns true", () => {
    const mgr = new ApprovalManager();
    const id = mgr.add("file.write", { path: "c.txt" });
    expect(mgr.reject(id)).toBe(true);
    expect(mgr.list()).toHaveLength(0);
  });

  it("reject returns false for unknown id", () => {
    const mgr = new ApprovalManager();
    expect(mgr.reject("nonexistent")).toBe(false);
  });

  it("onResolve fires listener on approve", () => {
    const mgr = new ApprovalManager();
    const calls: Array<[string, boolean]> = [];
    mgr.onResolve((id, approved) => calls.push([id, approved]));
    const id = mgr.add("file.write", {});
    mgr.approve(id);
    expect(calls).toEqual([[id, true]]);
  });

  it("onResolve fires listener on reject", () => {
    const mgr = new ApprovalManager();
    const calls: Array<[string, boolean]> = [];
    mgr.onResolve((id, approved) => calls.push([id, approved]));
    const id = mgr.add("file.write", {});
    mgr.reject(id);
    expect(calls).toEqual([[id, false]]);
  });
});
