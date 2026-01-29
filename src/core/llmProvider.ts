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

export class SiliconFlowProvider implements LLMProvider {
  constructor(
    private baseUrl: string,
    private apiKey: string
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = this.baseUrl.replace(/\/+$/, "") + "/chat/completions";

    const maxAttempts = 4;
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            temperature: req.temperature ?? 0.3,
            max_tokens: req.max_tokens ?? 800,
          }),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
            const backoff = 300 * attempt * attempt;
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 400)}`);
        }

        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string }; text?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const text =
          json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? "";

        return { text: String(text).trim(), usage: json?.usage, raw: json };
      } catch (e) {
        lastErr = e;
        const backoff = 300 * attempt * attempt;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("LLM call failed");
  }
}
