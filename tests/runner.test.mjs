import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner, validateDecision } from "../runner/agent-runner.mjs";
import { HarnessAdapter, parseDecision } from "../runner/harness.mjs";
import { McpClient } from "../runner/mcp-client.mjs";

class MemoryStateStore {
  constructor(state = {}) {
    this.state = {
      initialized: true,
      cursor: 0,
      lastSentAt: 0,
      lastProactiveAt: 0,
      lastRoomActivity: 0,
      ...state,
    };
  }
  load() {
    return structuredClone(this.state);
  }
  save(state) {
    this.state = structuredClone(state);
  }
}

const message = (id, overrides = {}) => ({
  id,
  ts: new Date(id * 1000).toISOString(),
  nick: "alice",
  text: `message ${id}`,
  automated: false,
  automation_depth: 0,
  ...overrides,
});

function clientWithReads(reads) {
  return {
    reads: [...reads],
    sends: [],
    async read() {
      return this.reads.shift();
    },
    async send(input) {
      this.sends.push(input);
      return { sent: message(99, { nick: input.nick, text: input.text, ts: new Date(100_000).toISOString() }) };
    },
  };
}

test("initializes at the latest retained cursor without replying to history", async () => {
  const stateStore = new MemoryStateStore({ initialized: false });
  const client = clientWithReads([
    { messages: [message(1), message(2)], next_cursor: 2, room_latest_id: 2, history_truncated: false },
  ]);
  let decisions = 0;
  const runner = new AgentRunner({
    client,
    adapter: { decide: async () => (decisions += 1) },
    stateStore,
    nick: "bot",
    now: () => 10_000,
  });

  await runner.tick();
  assert.equal(stateStore.state.cursor, 2);
  assert.equal(decisions, 0);
  assert.equal(client.sends.length, 0);
});

test("replies through the runner with automation metadata and idempotency", async () => {
  const stateStore = new MemoryStateStore({ lastRoomActivity: 1000 });
  const client = clientWithReads([
    { messages: [message(2)], next_cursor: 2, room_latest_id: 2, history_truncated: false },
    { messages: [], next_cursor: 2, room_latest_id: 2, history_truncated: false },
  ]);
  const runner = new AgentRunner({
    client,
    adapter: { decide: async () => ({ sessionId: "session-1", decision: { action: "send", text: "hello", reply_to: 2 } }) },
    stateStore,
    nick: "bot",
    now: () => 100_000,
    random: () => 0,
  });

  await runner.tick();
  assert.deepEqual(client.sends[0], {
    text: "hello",
    nick: "bot",
    reply_to: 2,
    automated: true,
    idempotency_key: "bot-reply-2",
  });
  assert.equal(stateStore.state.cursor, 2);
  assert.equal(stateStore.state.sessionId, "session-1");
});

test("holds incoming messages until the fifteen-second cooldown expires", async () => {
  const stateStore = new MemoryStateStore({ lastSentAt: 95_000 });
  const client = clientWithReads([
    { messages: [message(2)], next_cursor: 2, room_latest_id: 2, history_truncated: false },
  ]);
  let decisions = 0;
  const runner = new AgentRunner({
    client,
    adapter: { decide: async () => (decisions += 1) },
    stateStore,
    nick: "bot",
    now: () => 100_000,
  });

  await runner.tick();
  assert.equal(decisions, 0);
  assert.equal(stateStore.state.cursor, 0);
});

test("starts a proactive topic after one quiet minute", async () => {
  const stateStore = new MemoryStateStore({ lastRoomActivity: 1_000 });
  const client = clientWithReads([
    { messages: [], next_cursor: 0, room_latest_id: 0, history_truncated: false },
    { messages: [], next_cursor: 0, room_latest_id: 0, history_truncated: false },
  ]);
  const runner = new AgentRunner({
    client,
    adapter: { decide: async () => ({ decision: { action: "send", text: "New topic" } }) },
    stateStore,
    nick: "bot",
    now: () => 62_000,
    random: () => 0,
  });

  await runner.tick();
  assert.equal(client.sends[0].text, "New topic");
  assert.equal("reply_to" in client.sends[0], false);
  assert.equal(stateStore.state.lastProactiveAt, 62_000);
});

test("cancels a generated response when the room changes before send", async () => {
  const stateStore = new MemoryStateStore();
  const client = clientWithReads([
    { messages: [message(2)], next_cursor: 2, room_latest_id: 2, history_truncated: false },
    { messages: [message(3)], next_cursor: 3, room_latest_id: 3, history_truncated: false },
  ]);
  const runner = new AgentRunner({
    client,
    adapter: { decide: async () => ({ decision: { action: "send", text: "stale", reply_to: 2 } }) },
    stateStore,
    nick: "bot",
    now: () => 100_000,
    random: () => 0,
  });

  await runner.tick();
  assert.equal(client.sends.length, 0);
  assert.equal(stateStore.state.cursor, 0);
});

test("does not continue an automated chain beyond depth two", async () => {
  const stateStore = new MemoryStateStore();
  const client = clientWithReads([
    {
      messages: [message(2, { automated: true, automation_depth: 2 })],
      next_cursor: 2,
      room_latest_id: 2,
      history_truncated: false,
    },
  ]);
  let decisions = 0;
  const runner = new AgentRunner({
    client,
    adapter: { decide: async () => (decisions += 1) },
    stateStore,
    nick: "bot",
    now: () => 100_000,
  });

  await runner.tick();
  assert.equal(decisions, 0);
  assert.equal(stateStore.state.cursor, 2);
});

test("parses harness decisions and validates their interface", () => {
  assert.deepEqual(parseDecision('```json\n{"action":"skip"}\n```'), { action: "skip" });
  assert.throws(() => validateDecision({ action: "send", text: "" }), /1-4000/);
  assert.throws(() => validateDecision({ action: "send", text: "ok", reply_to: 0 }), /positive integer/);

  const codex = new HarnessAdapter("codex", { cwd: "/workspace" }).command(undefined);
  assert.deepEqual(codex.args.slice(0, 2), ["exec", "--json"]);
  assert.equal(codex.args.includes("workspace-write"), true);
  const claude = new HarnessAdapter("claude", { cwd: "/workspace" }).command("session-1");
  assert.equal(claude.args.includes("--resume"), true);
  assert.equal(claude.args.includes("Read,Glob,Grep"), true);
});

test("decodes SSE-framed MCP tool results", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"messages\\":[],\\"next_cursor\\":4}"}]}}\n\n',
  });
  const client = new McpClient("https://example.test/mcp", fetchImpl);
  assert.deepEqual(await client.read(4), { messages: [], next_cursor: 4 });
});
