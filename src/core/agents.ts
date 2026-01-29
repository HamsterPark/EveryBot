import type { ChatMessage, LLMProvider } from "./llmProvider.js";

export type AgentContext = {
  convId: string;
  agentId: string;
};

/** Minimal memory pack for agent context (full implementation in memory/memoryEngine) */
export type MemoryPack = {
  summary: string;
  facts: Record<string, unknown>;
  recentTurns: Array<{ role: "user" | "bot"; text: string }>;
};

export interface Agent {
  id: string;
  handle(userText: string, ctx: AgentContext, memory: MemoryPack): Promise<string>;
}

export class AgentRegistry {
  private map = new Map<string, Agent>();

  register(agent: Agent): void {
    this.map.set(agent.id, agent);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get(id: string): Agent {
    const a = this.map.get(id);
    if (!a) throw new Error(`Unknown agent: ${id}`);
    return a;
  }
}

function threadToMessages(recentTurns: MemoryPack["recentTurns"]): ChatMessage[] {
  return recentTurns.map((t) => ({
    role: t.role === "user" ? "user" : "assistant",
    content: t.text,
  }));
}

export class LlmAgent implements Agent {
  constructor(
    public id: string,
    private provider: LLMProvider,
    private model: string,
    private systemPrompt: string,
    private temperature = 0.3,
    private maxTokens = 900
  ) {}

  async handle(userText: string, _ctx: AgentContext, memory: MemoryPack): Promise<string> {
    const memBlock = [
      "## Conversation Summary",
      memory.summary?.trim() ? memory.summary.trim() : "(empty)",
      "",
      "## Facts (JSON)",
      JSON.stringify(memory.facts ?? {}, null, 2),
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt + "\n\n" + memBlock },
      ...threadToMessages(memory.recentTurns),
      { role: "user", content: userText },
    ];

    const res = await this.provider.chat({
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    });

    return res.text;
  }
}

export function createDefaultAgents(args: {
  provider: LLMProvider;
  models: { default: string; files: string; scheduler: string };
}): Agent[] {
  const { provider, models } = args;

  return [
    new LlmAgent(
      "default",
      provider,
      models.default,
      [
        "You are EveryBot (default agent).",
        "Be helpful, precise, and concise.",
        "If the user asks for file operations, suggest using the files agent; still answer normally.",
      ].join("\n")
    ),
    new LlmAgent(
      "files",
      provider,
      models.files,
      [
        "You are EveryBot (files agent).",
        "Your job is to help with local workspace file tasks.",
        "When needed, output a clear step-by-step plan or the exact file operations you would perform.",
      ].join("\n")
    ),
    new LlmAgent(
      "scheduler",
      provider,
      models.scheduler,
      [
        "You are EveryBot (scheduler agent).",
        "Your job is to help create and explain scheduled tasks.",
        "When the user requests a schedule, propose a task definition (schedule + action) clearly.",
      ].join("\n")
    ),
  ];
}
