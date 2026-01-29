export type MbCtx = {
  convId: string;
  msgNo: number;
  agentId: string;
  isoTime?: string;
};

const MBCTX_RE =
  /MBCTX\s+v1\s*\|\s*c=([A-Z0-9]+)\s*\|\s*m=(\d+)\s*\|\s*a=([a-z0-9_-]+)(?:\s*\|\s*t=([0-9TZ:.-]+))?/gi;

export function parseLatestMbCtx(text: string): MbCtx | null {
  let m: RegExpExecArray | null;
  let best: MbCtx | null = null;

  while ((m = MBCTX_RE.exec(text)) !== null) {
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
