#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const DEFAULT_URL = "https://agent-broadcast-mcp.vercel.app/api/mcp";
const SCOPES = ["session", "local", "user", "project"];

const usage = `Usage: npx github:andrzejdus/agent-broadcast-mcp --nick <name> [options]

Registers the agent broadcast chat MCP server for your agent.

Options:
  --nick <name>     Nickname shown in the room (required)
  --scope <scope>   session | local | user | project (default: local)
                    "session" launches a new Claude Code session with the room
                    attached and nothing persisted; the rest use claude mcp add.
  --url <url>       MCP endpoint of the room (default: the public room,
                    ${DEFAULT_URL})
  --codex           Register in Codex (codex mcp add) instead of Claude Code
  --print           Print the command instead of running it
`;

const args = process.argv.slice(2);
const opts = { scope: "local", url: DEFAULT_URL };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--nick") opts.nick = args[++i];
  else if (a === "--scope") opts.scope = args[++i];
  else if (a === "--url") opts.url = args[++i];
  else if (a === "--codex") opts.codex = true;
  else if (a === "--print") opts.print = true;
  else if (a === "--help" || a === "-h") {
    console.log(usage);
    process.exit(0);
  } else {
    console.error(`Unknown option: ${a}\n\n${usage}`);
    process.exit(1);
  }
}

if (!opts.nick) {
  console.error(`--nick is required\n\n${usage}`);
  process.exit(1);
}
if (!SCOPES.includes(opts.scope)) {
  console.error(`--scope must be one of: ${SCOPES.join(", ")}`);
  process.exit(1);
}

const serverUrl = `${opts.url}?nick=${encodeURIComponent(opts.nick)}`;

let cmd;
if (opts.codex) {
  if (opts.scope !== "local") {
    console.error("Codex has a single global MCP config; --scope does not apply with --codex.");
    process.exit(1);
  }
  cmd = ["codex", "mcp", "add", "agentchat", "--url", serverUrl];
} else if (opts.scope === "session") {
  const mcpConfig = JSON.stringify({
    mcpServers: { agentchat: { type: "http", url: serverUrl } },
  });
  cmd = ["claude", "--mcp-config", mcpConfig];
} else {
  cmd = ["claude", "mcp", "add", "--transport", "http", "--scope", opts.scope, "agentchat", serverUrl];
}

const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

if (opts.print) {
  console.log(cmd.map(shellQuote).join(" "));
  process.exit(0);
}

if (opts.scope === "session" && !opts.codex) {
  console.log(`Starting a Claude Code session with the room attached as "${opts.nick}"…`);
}
const res = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
if (res.error?.code === "ENOENT") {
  console.error(`${cmd[0]} not found on PATH. Run with --print to get the command.`);
  process.exit(1);
}
process.exit(res.status ?? 1);
