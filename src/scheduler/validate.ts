import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { Task, TaskAction } from "./schedulerEngine.js";

/** Task ids become part of a conversation id ("task-<id>"), so they get a shorter cap than plain ids. */
export const TASK_ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
export const ACTION_TYPES = ["sendMessage", "runTool", "runChat"] as const;
export const TOOL_NAMES = ["file.list", "file.read", "file.write", "file.delete"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the cron expression (and timezone) exactly the way the runner will, so bad input never reaches tasks.json. */
export function validateCron(cron: string, timezone?: string): void {
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new TaskValidationError(`Invalid timezone: ${timezone}`);
    }
  }
  try {
    // Without a callback croner only parses the pattern; nothing is scheduled.
    new Cron(cron, timezone ? { timezone } : {}).stop();
  } catch (e) {
    throw new TaskValidationError(`Invalid cron: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function parseTaskAction(input: unknown): TaskAction {
  if (!isPlainObject(input)) throw new TaskValidationError("Missing or invalid action");

  switch (input.type) {
    case "sendMessage": {
      if (input.channel !== "mail") throw new TaskValidationError('action.channel must be "mail"');
      if (typeof input.textTemplate !== "string" || !input.textTemplate) {
        throw new TaskValidationError("action.textTemplate must be a non-empty string");
      }
      if (input.target !== undefined && typeof input.target !== "string") {
        throw new TaskValidationError("action.target must be a string");
      }
      return { type: "sendMessage", channel: "mail", target: input.target, textTemplate: input.textTemplate };
    }
    case "runTool": {
      const toolName = input.toolName;
      if (typeof toolName !== "string" || !(TOOL_NAMES as readonly string[]).includes(toolName)) {
        throw new TaskValidationError(`action.toolName must be one of ${TOOL_NAMES.join(", ")}`);
      }
      const args = input.args ?? {};
      if (!isPlainObject(args)) throw new TaskValidationError("action.args must be an object");
      if (args.path !== undefined && typeof args.path !== "string") {
        throw new TaskValidationError("action.args.path must be a string");
      }
      return { type: "runTool", toolName, args };
    }
    case "runChat": {
      if (typeof input.promptTemplate !== "string" || !input.promptTemplate) {
        throw new TaskValidationError("action.promptTemplate must be a non-empty string");
      }
      return { type: "runChat", promptTemplate: input.promptTemplate };
    }
    default:
      throw new TaskValidationError(`action.type must be one of ${ACTION_TYPES.join(", ")}`);
  }
}

/** Validate an untrusted task definition (e.g. an HTTP body) into a well-formed task. */
export function parseTaskInput(body: Record<string, unknown>): Omit<Task, "createdAt" | "updatedAt"> {
  const id = body.id === undefined || body.id === null ? randomUUID() : body.id;
  if (typeof id !== "string" || !TASK_ID_RE.test(id)) {
    throw new TaskValidationError(`Invalid id: must match ${TASK_ID_RE}`);
  }

  if (typeof body.cron !== "string" || !body.cron.trim()) throw new TaskValidationError("Missing or invalid cron");

  const timezone = body.timezone === undefined || body.timezone === null ? undefined : body.timezone;
  if (timezone !== undefined && typeof timezone !== "string") throw new TaskValidationError("Invalid timezone");
  validateCron(body.cron, timezone);

  const action = parseTaskAction(body.action);

  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== "boolean") throw new TaskValidationError("Invalid enabled: must be a boolean");

  return { id, cron: body.cron, timezone, action, enabled };
}
