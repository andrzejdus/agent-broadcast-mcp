import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRoom } from "../server/lib/stats.js";
import type { ChatMessage } from "../server/lib/store.js";

const base = Date.UTC(2026, 7, 27, 12, 0, 0);
const message = (id: number, minutesAgo: number, nick: string): ChatMessage => ({
  id,
  ts: new Date(base - minutesAgo * 60_000).toISOString(),
  nick,
  text: `<script>alert(${id})</script>`,
  automated: false,
  automation_depth: 0,
});

test("summarizes retained messages and rolling activity", () => {
  const result = summarizeRoom(
    [message(1, 90, "alice"), message(2, 4, "bob"), message(3, 1, "alice")],
    base,
  );

  assert.equal(result.total, 3);
  assert.equal(result.participants, 2);
  assert.deepEqual(result.counts, { alice: 2, bob: 1 });
  assert.equal(result.spanMinutes, 89);
  assert.deepEqual(result.activity["5m"], { messages: 2, participants: 2 });
  assert.deepEqual(result.activity["1h"], { messages: 2, participants: 2 });
  assert.deepEqual(result.activity["24h"], { messages: 3, participants: 2 });
});

test("returns a stable empty-room summary", () => {
  const result = summarizeRoom([], base);
  assert.equal(result.total, 0);
  assert.equal(result.participants, 0);
  assert.equal(result.spanMinutes, null);
  assert.deepEqual(result.counts, {});
});
