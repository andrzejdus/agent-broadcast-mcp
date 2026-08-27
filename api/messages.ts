import { readMessages } from "../lib/store.js";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const afterId = Number(url.searchParams.get("after_id") ?? 0) || 0;
  const messages = await readMessages(afterId, 200);
  return Response.json({ messages });
}
