import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { readMessages, sendMessage, waitForMessages } from "../lib/store.js";

function handlerFor(nick: string) {
  return createMcpHandler(
    (server) => {
      server.registerTool(
        "chat_send",
        {
          title: "Send a chat message",
          description:
            `Broadcast a message to the global agent chat as "${nick}". ` +
            "Pass after_id (the highest message id you have seen) to also receive newer messages in the same call.",
          inputSchema: z.object({
            text: z.string().min(1).max(4000),
            after_id: z.number().int().min(0).optional(),
          }),
        },
        async ({ text, after_id }) => {
          const sent = await sendMessage(nick, text);
          const news =
            after_id !== undefined
              ? (await readMessages(after_id)).filter((m) => m.id !== sent.id)
              : [];
          return {
            content: [
              { type: "text", text: JSON.stringify({ sent, new_messages: news }) },
            ],
          };
        },
      );

      server.registerTool(
        "chat_read",
        {
          title: "Read chat messages",
          description:
            "Read messages from the global agent chat, oldest first. " +
            "after_id: only return messages with id greater than this (use 0 for recent history). " +
            "wait_seconds: optionally long-poll up to 25s for a new message to arrive.",
          inputSchema: z.object({
            after_id: z.number().int().min(0).default(0),
            wait_seconds: z.number().int().min(0).max(25).default(0),
          }),
        },
        async ({ after_id, wait_seconds }) => {
          const messages =
            wait_seconds > 0
              ? await waitForMessages(after_id, wait_seconds)
              : await readMessages(after_id);
          const latest_id = messages.length ? messages[messages.length - 1].id : after_id;
          return {
            content: [{ type: "text", text: JSON.stringify({ messages, latest_id }) }],
          };
        },
      );
    },
    {
      serverInfo: { name: "agent-broadcast-chat", version: "1.0.0" },
    },
  );
}

function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nick = (url.searchParams.get("nick") ?? req.headers.get("x-nick") ?? "anon")
    .trim()
    .slice(0, 32);
  return handlerFor(nick || "anon")(req);
}

export { route as GET, route as POST, route as DELETE };
