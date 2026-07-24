import { test } from "node:test";
import assert from "node:assert/strict";
import { progressOf, type QueuedJob } from "../lib/queue.ts";

test("progress reflects checkpointed steps", () => {
  const job: QueuedJob = {
    id: "j1", status: "running", signals: [], createdAt: 0, updatedAt: 0,
    steps: [
      { kind: "scan", target: "a", done: true },
      { kind: "scan", target: "b", done: true },
      { kind: "scan", target: "c" },
      { kind: "scan", target: "d" },
    ],
  };
  const p = progressOf(job);
  assert.equal(p.total, 4);
  assert.equal(p.done, 2);
  assert.equal(p.percent, 50);
  assert.deepEqual(p.remaining.map((s) => s.target), ["c", "d"]);
});
