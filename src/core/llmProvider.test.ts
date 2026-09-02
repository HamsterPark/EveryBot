import { describe, it, expect, vi } from "vitest";
import { OpenAICompatibleProvider, LLMHttpError, type ChatRequest } from "./llmProvider.js";

const req: ChatRequest = { model: "test-model", messages: [{ role: "user", content: "hi" }] };

function completion(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { total_tokens: 3 } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeProvider(fetchImpl: typeof fetch, options: { maxAttempts?: number; timeoutMs?: number } = {}) {
  return new OpenAICompatibleProvider("https://llm.example/v1/", "sk-test", {
    fetchImpl,
    baseDelayMs: 1,
    maxAttempts: options.maxAttempts ?? 4,
    timeoutMs: options.timeoutMs ?? 5000,
  });
}

describe("OpenAICompatibleProvider", () => {
  it("posts the chat-completions shape with a bearer token to <baseUrl>/chat/completions", async () => {
    const fetchImpl = vi.fn(async () => completion("hello"));
    const res = await makeProvider(fetchImpl as unknown as typeof fetch).chat({ ...req, temperature: 0.1 });

    expect(res.text).toBe("hello");
    expect(res.usage).toEqual({ total_tokens: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "test-model",
      messages: req.messages,
      temperature: 0.1,
      max_tokens: 800,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not retry client errors such as 401", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad key", { status: 401 }));
    const provider = makeProvider(fetchImpl as unknown as typeof fetch);
    await expect(provider.chat(req)).rejects.toThrow(LLMHttpError);
    await expect(provider.chat(req)).rejects.toThrow(/LLM HTTP 401: bad key/);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one call per chat(), never more
  });

  it("retries 5xx and 429 and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(completion("finally"));
    const res = await makeProvider(fetchImpl as unknown as typeof fetch).chat(req);
    expect(res.text).toBe("finally");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxAttempts and reports the last failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 502 }));
    const provider = makeProvider(fetchImpl as unknown as typeof fetch, { maxAttempts: 2 });
    await expect(provider.chat(req)).rejects.toThrow(/LLM HTTP 502/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung request after timeoutMs", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    );
    const provider = makeProvider(fetchImpl as unknown as typeof fetch, { maxAttempts: 1, timeoutMs: 20 });
    await expect(provider.chat(req)).rejects.toThrow(/timed out after 20 ms/);
  });

  it("retries network errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(completion("ok"));
    const res = await makeProvider(fetchImpl as unknown as typeof fetch).chat(req);
    expect(res.text).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
