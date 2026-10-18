import { test } from "node:test";
import assert from "node:assert/strict";
import { titleWords } from "../src/cluster.ts";
import { firstPage, nextPage } from "../src/snapshots.ts";

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
  assert.equal(nextPage("deadbeef:0", 10), null); // unknown snapshot
  assert.equal(nextPage(undefined, 10), null);
});
