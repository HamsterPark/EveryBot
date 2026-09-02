import type { AgentRegistry, MemoryPack } from "./agents.js";
import type { ConversationStore, ConvMeta, ThreadItem } from "../conversation/store.js";
import type { MemoryEngine } from "../memory/memoryEngine.js";

export type TurnDeps = {
  convStore: ConversationStore;
  agents: AgentRegistry;
  memoryEngine: MemoryEngine | null;
};

export type TurnResult = { replyText: string; msgNo: number };

/**
 * One request/response exchange with an agent.
 *
 * Order matters: the context is built from turns that happened *before* this message
 * (the agent appends the current user message itself), then both turns are persisted
 * and handed to the memory engine. The HTTP API, the e-mail channel and scheduled chats
 * all go through here so the behaviour is identical.
 */
export async function runConversationTurn(
  deps: TurnDeps,
  meta: ConvMeta,
  agentId: string,
  userText: string,
  opts: { emailId?: string } = {}
): Promise<TurnResult> {
  const { convStore, agents, memoryEngine } = deps;

  const memory: MemoryPack = memoryEngine
    ? await memoryEngine.buildMemoryPack(meta.convId)
    : {
        summary: "",
        facts: {},
        recentTurns: (await convStore.getThread(meta.convId)).map((t) => ({ role: t.role, text: t.text })),
      };

  const userItem: ThreadItem = { role: "user", text: userText, at: new Date().toISOString(), emailId: opts.emailId };
  await convStore.append(meta.convId, userItem);

  const agent = agents.get(agentId);
  const replyText = await agent.handle(userText, { convId: meta.convId, agentId }, memory);

  const msgNo = await convStore.nextBotMsgNo(meta.convId);
  const botItem: ThreadItem = { role: "bot", text: replyText, at: new Date().toISOString(), msgNo, agentId };
  await convStore.append(meta.convId, botItem);

  if (memoryEngine) await memoryEngine.afterReply(meta.convId, [userItem, botItem]);

  return { replyText, msgNo };
}
