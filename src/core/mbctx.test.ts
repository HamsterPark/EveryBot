import { describe, it, expect } from "vitest";
import { formatMbCtxFooter, parseLatestMbCtx } from "./mbctx.js";

describe("MBCTX footer", () => {
  it("round-trips through format and parse", () => {
    const footer = formatMbCtxFooter({
      convId: "AB12CD34EF",
      msgNo: 7,
      agentId: "files",
      isoTime: "2026-09-01T10:00:00Z",
    });
    expect(footer).toBe("---\nMBCTX v1 | c=AB12CD34EF | m=7 | a=files | t=2026-09-01T10:00:00Z\n");
    expect(parseLatestMbCtx(`Thanks!\n\n> quoted reply\n> ${footer}`)).toEqual({
      convId: "AB12CD34EF",
      msgNo: 7,
      agentId: "files",
      isoTime: "2026-09-01T10:00:00Z",
    });
  });

  it("picks the footer with the highest message number when several are quoted", () => {
    const text = [
      "reply",
      formatMbCtxFooter({ convId: "OLD", msgNo: 2, agentId: "default" }),
      formatMbCtxFooter({ convId: "NEW", msgNo: 5, agentId: "default" }),
      formatMbCtxFooter({ convId: "OLDER", msgNo: 1, agentId: "default" }),
    ].join("\n");
    expect(parseLatestMbCtx(text)?.convId).toBe("NEW");
  });

  it("accepts task-style conversation ids and returns null when absent", () => {
    expect(parseLatestMbCtx("MBCTX v1 | c=task-daily_report | m=3 | a=default")?.convId).toBe("task-daily_report");
    expect(parseLatestMbCtx("no footer here")).toBeNull();
    expect(parseLatestMbCtx("MBCTX v1 | c=../etc | m=1 | a=default")).toBeNull();
  });
});
