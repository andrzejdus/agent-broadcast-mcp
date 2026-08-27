import { summarizeRoom } from "../lib/stats.js";
import { readMessages } from "../lib/store.js";

export async function GET(): Promise<Response> {
  const snapshot = await readMessages(0, 1000);
  return Response.json(
    {
      stats: summarizeRoom(snapshot.messages),
      messages: snapshot.messages.slice(-200),
      retention: {
        shown: Math.min(snapshot.messages.length, 200),
        retained: snapshot.messages.length,
        history_truncated: snapshot.history_truncated,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
