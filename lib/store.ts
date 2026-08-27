import { Redis } from "@upstash/redis";

export const MAX_MESSAGES = 1000;
export const MAX_PAGE_SIZE = 1000;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export type ChatMessage = {
  id: number;
  ts: string;
  nick: string;
  text: string;
  reply_to?: number;
  automated: boolean;
  automation_depth: number;
};

export type SendMessageInput = {
  nick: string;
  text: string;
  reply_to?: number;
  automated?: boolean;
  idempotency_key?: string;
};

export type ReadMessagesResult = {
  messages: ChatMessage[];
  next_cursor: number;
  room_latest_id: number;
  latest_id: number;
  has_more: boolean;
  history_truncated: boolean;
};

type MessageDraft = Omit<ChatMessage, "id">;

export interface MessageBackend {
  append(draft: MessageDraft, idempotencyKey?: string): Promise<ChatMessage>;
  readRetained(): Promise<ChatMessage[]>;
}

export class ChatStore {
  constructor(
    private readonly backend: MessageBackend,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(input: SendMessageInput): Promise<ChatMessage> {
    const nick = normalizeNick(input.nick);
    const automated = input.automated ?? false;
    let automationDepth = 0;

    if (input.reply_to !== undefined) {
      const retained = await this.backend.readRetained();
      const parent = retained.find((message) => message.id === input.reply_to);
      if (!parent) throw new Error(`reply_to ${input.reply_to} is not a retained message`);
      if (automated) automationDepth = parent.automation_depth + 1;
    }

    if (automated && automationDepth > 2) {
      throw new Error("automated reply chain exceeds the maximum depth of 2");
    }

    return this.backend.append(
      {
        ts: this.now().toISOString(),
        nick,
        text: input.text,
        ...(input.reply_to === undefined ? {} : { reply_to: input.reply_to }),
        automated,
        automation_depth: automationDepth,
      },
      input.idempotency_key,
    );
  }

  async read(afterId = 0, limit = 100): Promise<ReadMessagesResult> {
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(limit)));
    const retained = (await this.backend.readRetained()).sort((a, b) => a.id - b.id);
    const oldestId = retained[0]?.id ?? 0;
    const roomLatestId = retained.at(-1)?.id ?? 0;
    const candidates = retained.filter((message) => message.id > afterId);
    const messages = candidates.slice(0, pageSize);
    const nextCursor = messages.at(-1)?.id ?? afterId;

    return {
      messages,
      next_cursor: nextCursor,
      room_latest_id: roomLatestId,
      latest_id: nextCursor,
      has_more: candidates.length > messages.length,
      history_truncated: retained.length > 0 && oldestId > afterId + 1,
    };
  }

  async wait(afterId: number, waitSeconds: number, limit = 100): Promise<ReadMessagesResult> {
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 25) * 1000;
    for (;;) {
      const result = await this.read(afterId, limit);
      if (result.messages.length > 0 || Date.now() >= deadline) return result;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

export class MemoryMessageBackend implements MessageBackend {
  private sequence = 0;
  private readonly messages: ChatMessage[] = [];
  private readonly idempotentMessages = new Map<string, ChatMessage>();

  constructor(private readonly maxMessages = MAX_MESSAGES) {}

  async append(draft: MessageDraft, idempotencyKey?: string): Promise<ChatMessage> {
    const scopedKey = idempotencyKey ? `${draft.nick}\u0000${idempotencyKey}` : undefined;
    if (scopedKey) {
      const existing = this.idempotentMessages.get(scopedKey);
      if (existing) return existing;
    }

    const message = { id: ++this.sequence, ...draft };
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) this.messages.shift();
    if (scopedKey) this.idempotentMessages.set(scopedKey, message);
    return message;
  }

  async readRetained(): Promise<ChatMessage[]> {
    return structuredClone(this.messages);
  }
}

const APPEND_SCRIPT = `
local idempotency_key = KEYS[3]
if idempotency_key ~= '' then
  local existing = redis.call('GET', idempotency_key)
  if existing then return existing end
end

local id = redis.call('INCR', KEYS[2])
local message = {
  id = id,
  ts = ARGV[1],
  nick = ARGV[2],
  text = ARGV[3],
  automated = ARGV[5] == '1',
  automation_depth = tonumber(ARGV[6])
}
if ARGV[4] ~= '' then message.reply_to = tonumber(ARGV[4]) end

local encoded = cjson.encode(message)
redis.call('LPUSH', KEYS[1], encoded)
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[7]) - 1)
if idempotency_key ~= '' then
  redis.call('SET', idempotency_key, encoded, 'EX', tonumber(ARGV[8]))
end
return encoded
`;

class RedisMessageBackend implements MessageBackend {
  private static readonly LOG_KEY = "chat:log";
  private static readonly SEQ_KEY = "chat:seq";

  constructor(private readonly redis: Redis) {}

  async append(draft: MessageDraft, idempotencyKey?: string): Promise<ChatMessage> {
    const key = idempotencyKey ? `chat:idem:${draft.nick}:${idempotencyKey}` : "";
    const result = await this.redis.eval<
      [string, string, string, string, string, string, string, string],
      unknown
    >(
      APPEND_SCRIPT,
      [RedisMessageBackend.LOG_KEY, RedisMessageBackend.SEQ_KEY, key],
      [
        draft.ts,
        draft.nick,
        draft.text,
        draft.reply_to?.toString() ?? "",
        draft.automated ? "1" : "0",
        draft.automation_depth.toString(),
        MAX_MESSAGES.toString(),
        IDEMPOTENCY_TTL_SECONDS.toString(),
      ],
    );
    return parseMessage(result);
  }

  async readRetained(): Promise<ChatMessage[]> {
    const raw = await this.redis.lrange<unknown>(
      RedisMessageBackend.LOG_KEY,
      0,
      MAX_MESSAGES - 1,
    );
    return raw.map(parseMessage).reverse();
  }
}

function parseMessage(value: unknown): ChatMessage {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object") throw new Error("invalid stored chat message");
  const legacy = parsed as Partial<ChatMessage>;
  return {
    ...(legacy as ChatMessage),
    automated: legacy.automated ?? false,
    automation_depth: legacy.automation_depth ?? 0,
  };
}

export function normalizeNick(nick: string): string {
  return nick.trim().slice(0, 32) || "anon";
}

let defaultStore: ChatStore | undefined;

export function getChatStore(): ChatStore {
  if (!defaultStore) {
    const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Redis is not configured: set KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*)",
      );
    }
    defaultStore = new ChatStore(new RedisMessageBackend(new Redis({ url, token })));
  }
  return defaultStore;
}

export async function sendMessage(input: SendMessageInput): Promise<ChatMessage> {
  return getChatStore().send(input);
}

export async function readMessages(afterId = 0, limit = 100): Promise<ReadMessagesResult> {
  return getChatStore().read(afterId, limit);
}

export async function waitForMessages(
  afterId: number,
  waitSeconds: number,
  limit = 100,
): Promise<ReadMessagesResult> {
  return getChatStore().wait(afterId, waitSeconds, limit);
}
