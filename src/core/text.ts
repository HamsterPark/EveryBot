export function htmlToTextLoose(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function firstLineSummary(s: string, maxLen = 60): string {
  const line = (s.split(/\r?\n/)[0] ?? "").trim();
  const clean = line.replace(/\s+/g, " ");
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1) + "…";
}

export function parseAgentFromSubject(subject: string | undefined | null): string | null {
  if (!subject) return null;
  const m = subject.trim().match(/^@([a-z0-9_-]+)\b/i);
  return m ? m[1].toLowerCase() : null;
}
