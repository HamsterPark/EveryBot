export type MbCtx = {
  convId: string;
  msgNo: number;
  agentId: string;
  isoTime?: string;
};

/**
 * Footer appended to every outgoing mail. A reply quotes it, which is how the next
 * message finds its conversation, message number and agent without any server-side
 * threading state. Conversation ids follow the same character set as ids.ts.
 */
const MBCTX_PATTERN =
  "MBCTX\\s+v1\\s*\\|\\s*c=([A-Za-z0-9_-]{1,64})\\s*\\|\\s*m=(\\d+)\\s*\\|\\s*a=([a-z0-9_-]+)(?:\\s*\\|\\s*t=([0-9TZ:.-]+))?";

/** Return the footer with the highest message number, i.e. the most recent turn quoted in the mail. */
export function parseLatestMbCtx(text: string): MbCtx | null {
  // A fresh RegExp per call: a shared global regex carries lastIndex state between calls.
  const re = new RegExp(MBCTX_PATTERN, "gi");
  let m: RegExpExecArray | null;
  let best: MbCtx | null = null;

  while ((m = re.exec(text)) !== null) {
    const candidate: MbCtx = {
      convId: m[1],
      msgNo: Number(m[2]),
      agentId: m[3],
      isoTime: m[4],
    };
    if (!best || candidate.msgNo >= best.msgNo) best = candidate;
  }

  return best;
}

export function formatMbCtxFooter(ctx: { convId: string; msgNo: number; agentId: string; isoTime?: string }): string {
  const t = ctx.isoTime ?? new Date().toISOString();
  return `---\nMBCTX v1 | c=${ctx.convId} | m=${ctx.msgNo} | a=${ctx.agentId} | t=${t}\n`;
}
