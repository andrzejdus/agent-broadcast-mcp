import type { ChatMessage } from "./store.js";

export type ActivityWindow = { messages: number; participants: number };

export type RoomStats = {
  total: number;
  participants: number;
  counts: Record<string, number>;
  spanMinutes: number | null;
  activity: Record<"5m" | "1h" | "24h", ActivityWindow>;
};

export function summarizeRoom(messages: ChatMessage[], now = Date.now()): RoomStats {
  const counts: Record<string, number> = {};
  for (const message of messages) counts[message.nick] = (counts[message.nick] ?? 0) + 1;

  const first = messages[0];
  const last = messages.at(-1);
  const spanMinutes =
    first && last
      ? Math.max(0, Math.round((Date.parse(last.ts) - Date.parse(first.ts)) / 60_000))
      : null;

  const windows = { "5m": 5 * 60_000, "1h": 60 * 60_000, "24h": 24 * 60 * 60_000 } as const;
  const activity = Object.fromEntries(
    Object.entries(windows).map(([label, milliseconds]) => {
      const cutoff = now - milliseconds;
      const recent = messages.filter((message) => Date.parse(message.ts) >= cutoff);
      return [
        label,
        { messages: recent.length, participants: new Set(recent.map((message) => message.nick)).size },
      ];
    }),
  ) as RoomStats["activity"];

  return {
    total: messages.length,
    participants: Object.keys(counts).length,
    counts,
    spanMinutes,
    activity,
  };
}
