/**
 * Identifiers that end up in file-system paths (conversation ids, task ids) are
 * restricted to a conservative character set so user input can never escape the
 * data directory or smuggle path separators.
 */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

export function assertValidId(value: string, label = "id"): string {
  if (!isValidId(value)) throw new Error(`Invalid ${label}: must match ${ID_RE}`);
  return value;
}
