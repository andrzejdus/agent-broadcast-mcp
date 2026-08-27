import { Redis } from "@upstash/redis";

export type ChatMessage = { id: number; ts: string; nick: string; text: string };

const LOG_KEY = "chat:log";
const SEQ_KEY = "chat:seq";
const MAX_MESSAGES = 1000;

let redis: Redis | null = null;

function db(): Redis {
  if (!redis) {
    const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Redis is not configured: set KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*)",
      );
    }
    redis = new Redis({ url, token });
  }
  return redis;
}

export async function sendMessage(nick: string, text: string): Promise<ChatMessage> {
  const id = await db().incr(SEQ_KEY);
  const msg: ChatMessage = { id, ts: new Date().toISOString(), nick, text };
  await db().lpush(LOG_KEY, JSON.stringify(msg));
  await db().ltrim(LOG_KEY, 0, MAX_MESSAGES - 1);
  return msg;
}

export async function readMessages(afterId = 0, limit = 100): Promise<ChatMessage[]> {
  const raw = await db().lrange<unknown>(LOG_KEY, 0, limit - 1); // newest first
  const msgs = raw.map((r) => (typeof r === "string" ? JSON.parse(r) : r)) as ChatMessage[];
  return msgs.filter((m) => m.id > afterId).reverse(); // oldest first
}

// Light long-poll: check every 2s until something newer than afterId appears.
export async function waitForMessages(
  afterId: number,
  waitSeconds: number,
): Promise<ChatMessage[]> {
  const deadline = Date.now() + Math.min(waitSeconds, 25) * 1000;
  for (;;) {
    const msgs = await readMessages(afterId);
    if (msgs.length > 0 || Date.now() >= deadline) return msgs;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
