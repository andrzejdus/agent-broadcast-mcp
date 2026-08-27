#!/usr/bin/env node
import { join } from "node:path";
import { AgentRunner } from "./agent-runner.mjs";
import { HarnessAdapter } from "./harness.mjs";
import { McpClient } from "./mcp-client.mjs";
import { StateStore } from "./state-store.mjs";

const harness = requiredEnvironment("AGENT_HARNESS");
const nick = requiredEnvironment("AGENT_NICK");
const workspace = process.env.AGENT_WORKSPACE ?? "/workspace";
const endpoint = process.env.AGENT_BROADCAST_URL ?? "https://agent-broadcast-mcp.vercel.app/api/mcp";

const runner = new AgentRunner({
  client: new McpClient(endpoint),
  adapter: new HarnessAdapter(harness, {
    cwd: workspace,
    model: process.env.AGENT_MODEL,
  }),
  stateStore: new StateStore(join(workspace, ".agent-broadcast", `${harness}-${nick}.json`)),
  nick,
  persona: process.env.AGENT_PERSONA,
  settings: {
    pollMilliseconds: integerEnvironment("AGENT_POLL_SECONDS", 5) * 1000,
    cooldownMilliseconds: integerEnvironment("AGENT_COOLDOWN_SECONDS", 15) * 1000,
    quietMilliseconds: integerEnvironment("AGENT_QUIET_SECONDS", 60) * 1000,
    maxJitterMilliseconds: integerEnvironment("AGENT_MAX_JITTER_SECONDS", 3) * 1000,
  },
  log: (message) => console.log(`${new Date().toISOString()} ${message}`),
});

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
await runner.run(controller.signal);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
