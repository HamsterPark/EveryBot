export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
};

export type ChatResponse = {
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  raw?: unknown;
};

export interface LLMProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export type ProviderOptions = {
  /** Abort a single HTTP attempt after this many milliseconds (default 60 000). */
  timeoutMs?: number;
  /** Total attempts for retryable failures: network errors, timeouts, 429 and 5xx (default 4). */
  maxAttempts?: number;
  /** Base delay for exponential backoff between attempts (default 300 ms). */
  baseDelayMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
};

export class LLMHttpError extends Error {
  constructor(
    public status: number,
    body: string
  ) {
    super(`LLM HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "LLMHttpError";
  }
}

type CompletionJson = {
  choices?: Array<{ message?: { content?: string }; text?: string }>;
  usage?: ChatResponse["usage"];
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, 30) * 1000;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Chat-completions client for any OpenAI-compatible endpoint (SiliconFlow, OpenAI,
 * DeepSeek, or a local server such as Ollama / vLLM).
 *
 * Retry policy: network errors, timeouts, 429 and 5xx are retried with exponential
 * backoff (honouring Retry-After); every other 4xx is a caller error and fails fast.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    options: ProviderOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.baseDelayMs = options.baseDelayMs ?? 300;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = this.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.max_tokens ?? 800,
    });

    let lastErr: unknown = new Error("LLM call failed");

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let retryAfterMs: number | undefined;
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (res.ok) return await this.parseResponse(res);

        const text = await res.text().catch(() => "");
        const httpErr = new LLMHttpError(res.status, text);
        if (!isRetryableStatus(res.status)) throw httpErr;
        lastErr = httpErr;
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      } catch (e) {
        if (e instanceof LLMHttpError && !isRetryableStatus(e.status)) throw e;
        lastErr =
          e instanceof Error && e.name === "TimeoutError"
            ? new Error(`LLM request timed out after ${this.timeoutMs} ms`, { cause: e })
            : e;
      }

      if (attempt < this.maxAttempts) {
        await sleep(retryAfterMs ?? this.baseDelayMs * 2 ** (attempt - 1));
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async parseResponse(res: Response): Promise<ChatResponse> {
    const json = (await res.json()) as CompletionJson;
    const text = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? "";
    return { text: String(text).trim(), usage: json?.usage, raw: json };
  }
}
