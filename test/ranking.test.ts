import { test } from "node:test";
import assert from "node:assert/strict";
import { titleWords } from "../src/cluster.ts";
import { CursorExpiredError, firstPage, MAX_SNAPSHOTS, nextPage } from "../src/snapshots.ts";

test("titleWords keeps the distinctive words and folds plurals", () => {
  const w = titleWords("SpaceX in talks to raise $40 billion in loans for Nvidia chips: Report");
  for (const word of ["spacex", "billion", "loan", "nvidia", "chip"]) assert.ok(w.has(word), word);
  for (const word of ["in", "to", "for", "the"]) assert.ok(!w.has(word), word);
});

test("snapshot pages cover every row once, in order", () => {
  const rows = Array.from({ length: 23 }, (_, i) => i);
  const first = firstPage(rows, { tag: "x" }, 10);
  const seen = [...first.rows];
  let next = first.next;
  while (next) {
    const page = nextPage<number, { tag: string }>(next, 10)!;
    assert.equal(page.meta.tag, "x");
    seen.push(...page.rows);
    next = page.next;
  }
  assert.deepEqual(seen, rows);
  assert.equal(first.total, 23);
});

test("nextPage ignores cursors that aren't snapshot cursors", () => {
  assert.equal(nextPage("2026-10-17T00:00:00.000Z|42", 10), null);
  assert.equal(nextPage(undefined, 10), null);
});

test("nextPage refuses a snapshot cursor whose snapshot is gone", () => {
  assert.throws(() => nextPage("deadbeef:0", 10), CursorExpiredError);
});

test("a snapshot being paged through outlives newer, unread ones", () => {
  const reading = firstPage([1, 2, 3], null, 1);
  const unread = firstPage([4, 5, 6], null, 1);
  for (let i = 0; i < MAX_SNAPSHOTS - 2; i++) firstPage([i], null, 1);
  const second = nextPage<number, null>(reading.next!, 1)!; // touching it moves it to the back
  firstPage([0], null, 1);
  firstPage([0], null, 1);
  assert.deepEqual(nextPage<number, null>(second.next!, 1)!.rows, [3]);
  assert.throws(() => nextPage(unread.next!, 1), CursorExpiredError);
});
