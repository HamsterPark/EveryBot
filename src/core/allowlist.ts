/** Parse a comma-separated list of e-mail addresses from an env var (case-insensitive). */
export function parseAddressList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Case-insensitive membership check. When the explicit allowlist is empty, only the
 * fallback address (the mailbox owner) is allowed; when it is configured, it is
 * authoritative and the fallback is not implicitly included.
 */
export function isAllowedAddress(address: string | null | undefined, allowlist: string[], fallback: string): boolean {
  if (!address) return false;
  const candidate = address.trim().toLowerCase();
  if (!candidate) return false;
  const effective = allowlist.length > 0 ? allowlist : parseAddressList(fallback);
  return effective.includes(candidate);
}
