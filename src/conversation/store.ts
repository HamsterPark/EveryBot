import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "../core/atomicWrite.js";
import { assertValidId, isValidId } from "./ids.js";
import type { ConvMeta, ThreadItem } from "./types.js";

function randomConvId(): string {
  return randomBytes(5).toString("hex").toUpperCase();
}

/**
 * File-backed conversation store: data/conv/<convId>/meta.json + thread.jsonl.
 * Every convId is validated before it is joined into a path.
 */
export class ConversationStore {
  constructor(private dataDir: string) {}

  private convDir(convId: string): string {
    return path.join(this.dataDir, "conv", assertValidId(convId, "conversation id"));
  }

  private metaPath(convId: string): string {
    return path.join(this.convDir(convId), "meta.json");
  }

  private threadPath(convId: string): string {
    return path.join(this.convDir(convId), "thread.jsonl");
  }

  /** Create a conversation; pass an explicit id to get a stable, addressable conversation. */
  async createConversation(agentId: string, convId: string = randomConvId()): Promise<ConvMeta> {
    const dir = this.convDir(convId);
    await fs.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const meta: ConvMeta = {
      convId,
      agentId,
      nextMsgNo: 1,
      createdAt: now,
      updatedAt: now,
    };
    await writeFileAtomic(this.metaPath(convId), JSON.stringify(meta, null, 2));
    return meta;
  }

  async loadMeta(convId: string): Promise<ConvMeta> {
    const raw = await fs.readFile(this.metaPath(convId), "utf-8");
    return JSON.parse(raw) as ConvMeta;
  }

  async saveMeta(meta: ConvMeta): Promise<void> {
    meta.updatedAt = new Date().toISOString();
    await writeFileAtomic(this.metaPath(meta.convId), JSON.stringify(meta, null, 2));
  }

  /** Load the conversation, or start a fresh one (with a new random id) when it does not exist. */
  async ensureConversation(convId: string, defaultAgent: string): Promise<ConvMeta> {
    assertValidId(convId, "conversation id");
    try {
      return await this.loadMeta(convId);
    } catch {
      return await this.createConversation(defaultAgent);
    }
  }

  /** Load the conversation, or create it under exactly this id. */
  async getOrCreateConversation(convId: string, agentId: string): Promise<ConvMeta> {
    assertValidId(convId, "conversation id");
    try {
      return await this.loadMeta(convId);
    } catch {
      return await this.createConversation(agentId, convId);
    }
  }

  async append(convId: string, item: ThreadItem): Promise<void> {
    await fs.mkdir(this.convDir(convId), { recursive: true });
    await fs.appendFile(this.threadPath(convId), JSON.stringify(item) + "\n", "utf-8");
  }

  async nextBotMsgNo(convId: string): Promise<number> {
    const meta = await this.loadMeta(convId);
    const n = meta.nextMsgNo;
    meta.nextMsgNo += 1;
    await this.saveMeta(meta);
    return n;
  }

  async listConversations(): Promise<ConvMeta[]> {
    const convRoot = path.join(this.dataDir, "conv");
    try {
      const ids = await fs.readdir(convRoot);
      const metas: ConvMeta[] = [];
      for (const id of ids) {
        if (!isValidId(id)) continue;
        try {
          metas.push(await this.loadMeta(id));
        } catch {
          // skip directories without a readable meta.json
        }
      }
      metas.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      return metas;
    } catch {
      return [];
    }
  }

  async getThread(convId: string, limit = 50): Promise<ThreadItem[]> {
    const p = this.threadPath(convId);
    try {
      const raw = await fs.readFile(p, "utf-8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const items = lines.map((line) => JSON.parse(line) as ThreadItem);
      return items.slice(-limit);
    } catch {
      return [];
    }
  }
}

export type { ConvMeta, ThreadItem };
