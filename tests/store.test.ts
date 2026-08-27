import assert from "node:assert/strict";
import test from "node:test";
import { ChatStore, MemoryMessageBackend } from "../lib/store.js";

function makeStore(maxMessages = 1000): ChatStore {
  let tick = 0;
  return new ChatStore(
    new MemoryMessageBackend(maxMessages),
    () => new Date(Date.UTC(2026, 7, 27, 12, 0, tick++)),
  );
}

test("reads retained history in stable cursor pages", async () => {
  const store = makeStore();
  for (let i = 1; i <= 5; i++) await store.send({ nick: "alice", text: `message ${i}` });

  const first = await store.read(0, 2);
  assert.deepEqual(first.messages.map((message) => message.id), [1, 2]);
  assert.equal(first.next_cursor, 2);
  assert.equal(first.latest_id, 2);
  assert.equal(first.room_latest_id, 5);
  assert.equal(first.has_more, true);
  assert.equal(first.history_truncated, false);

  const second = await store.read(first.next_cursor, 2);
  assert.deepEqual(second.messages.map((message) => message.id), [3, 4]);
  assert.equal(second.has_more, true);

  const third = await store.read(second.next_cursor, 2);
  assert.deepEqual(third.messages.map((message) => message.id), [5]);
  assert.equal(third.has_more, false);
});

test("reports a cursor whose missing history was evicted", async () => {
  const store = makeStore(3);
  for (let i = 1; i <= 5; i++) await store.send({ nick: "alice", text: `message ${i}` });

  const result = await store.read(1, 100);
  assert.deepEqual(result.messages.map((message) => message.id), [3, 4, 5]);
  assert.equal(result.history_truncated, true);
  assert.equal(result.room_latest_id, 5);
});

test("deduplicates retries by nickname and idempotency key", async () => {
  const store = makeStore();
  const first = await store.send({ nick: "alice", text: "hello", idempotency_key: "retry-1" });
  const retry = await store.send({ nick: "alice", text: "hello", idempotency_key: "retry-1" });
  const otherNick = await store.send({ nick: "bob", text: "hello", idempotency_key: "retry-1" });

  assert.deepEqual(retry, first);
  assert.equal(otherNick.id, 2);
  assert.equal((await store.read()).messages.length, 2);
});

test("normalizes nicknames and preserves plain-message defaults", async () => {
  const store = makeStore();
  const message = await store.send({
    nick: "  a nickname longer than thirty-two characters  ",
    text: "hello",
  });
  assert.equal(message.nick, "a nickname longer than thirty-tw");
  assert.equal(message.automated, false);
  assert.equal(message.automation_depth, 0);
});

test("enforces server-derived automated reply depth", async () => {
  const store = makeStore();
  const root = await store.send({ nick: "alice", text: "topic", automated: true });
  const reply1 = await store.send({ nick: "bob", text: "one", automated: true, reply_to: root.id });
  const reply2 = await store.send({ nick: "alice", text: "two", automated: true, reply_to: reply1.id });

  assert.equal(root.automation_depth, 0);
  assert.equal(reply1.automation_depth, 1);
  assert.equal(reply2.automation_depth, 2);
  await assert.rejects(
    store.send({ nick: "bob", text: "three", automated: true, reply_to: reply2.id }),
    /maximum depth of 2/,
  );
  await assert.rejects(
    store.send({ nick: "bob", text: "missing", automated: true, reply_to: 999 }),
    /not a retained message/,
  );
});
