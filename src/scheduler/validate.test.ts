import { describe, it, expect } from "vitest";
import { parseTaskAction, parseTaskInput, validateCron, TaskValidationError } from "./validate.js";

describe("validateCron", () => {
  it("accepts 5- and 6-field expressions", () => {
    expect(() => validateCron("*/5 * * * *")).not.toThrow();
    expect(() => validateCron("0 30 8 * * 1-5")).not.toThrow();
    expect(() => validateCron("0 9 * * *", "Asia/Shanghai")).not.toThrow();
  });

  it("rejects garbage and invalid timezones with TaskValidationError", () => {
    expect(() => validateCron("not a cron")).toThrow(TaskValidationError);
    expect(() => validateCron("* * * * *", "Mars/Olympus_Mons")).toThrow(/timezone/i);
  });
});

describe("parseTaskAction", () => {
  it("accepts the three action types", () => {
    expect(parseTaskAction({ type: "runChat", promptTemplate: "hi" })).toEqual({
      type: "runChat",
      promptTemplate: "hi",
    });
    expect(parseTaskAction({ type: "runTool", toolName: "file.list" })).toEqual({
      type: "runTool",
      toolName: "file.list",
      args: {},
    });
    expect(parseTaskAction({ type: "sendMessage", channel: "mail", textTemplate: "ping" })).toEqual({
      type: "sendMessage",
      channel: "mail",
      target: undefined,
      textTemplate: "ping",
    });
  });

  it("rejects unknown types, unknown tools and missing fields", () => {
    expect(() => parseTaskAction({ type: "shell", cmd: "rm -rf /" })).toThrow(/action\.type/);
    expect(() => parseTaskAction({ type: "runTool", toolName: "shell.exec" })).toThrow(/toolName/);
    expect(() => parseTaskAction({ type: "runTool", toolName: "file.read", args: { path: 42 } })).toThrow(/path/);
    expect(() => parseTaskAction({ type: "runChat" })).toThrow(/promptTemplate/);
    expect(() => parseTaskAction({ type: "sendMessage", channel: "sms", textTemplate: "x" })).toThrow(/channel/);
    expect(() => parseTaskAction(null)).toThrow(/action/);
    expect(() => parseTaskAction([])).toThrow(/action/);
  });
});

describe("parseTaskInput", () => {
  const action = { type: "runChat", promptTemplate: "Daily summary please" };

  it("fills in a UUID id and enabled=true by default", () => {
    const task = parseTaskInput({ cron: "0 9 * * *", action });
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.enabled).toBe(true);
    expect(task.timezone).toBeUndefined();
    expect(task.action).toEqual(action);
  });

  it("rejects ids that are not path-safe or too long", () => {
    expect(() => parseTaskInput({ id: "../x", cron: "* * * * *", action })).toThrow(/Invalid id/);
    expect(() => parseTaskInput({ id: "a".repeat(49), cron: "* * * * *", action })).toThrow(/Invalid id/);
    expect(parseTaskInput({ id: "daily_report-1", cron: "* * * * *", action }).id).toBe("daily_report-1");
  });

  it("reports missing cron before anything else", () => {
    expect(() => parseTaskInput({ action })).toThrow(/cron/);
    expect(() => parseTaskInput({ cron: "61 * * * *", action })).toThrow(/Invalid cron/);
  });

  it("rejects non-boolean enabled and non-string timezone", () => {
    expect(() => parseTaskInput({ cron: "* * * * *", action, enabled: "yes" })).toThrow(/enabled/);
    expect(() => parseTaskInput({ cron: "* * * * *", action, timezone: 8 })).toThrow(/timezone/);
  });
});
