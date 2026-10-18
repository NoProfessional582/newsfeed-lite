import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMIT, MAX_DAYS, MAX_LIMIT, ParamError, parseLimit, parseSince } from "../src/params.ts";

test("parseLimit defaults, caps and refuses nonsense", () => {
  assert.equal(parseLimit(undefined), DEFAULT_LIMIT);
  assert.equal(parseLimit(""), DEFAULT_LIMIT);
  assert.equal(parseLimit("20"), 20);
  assert.equal(parseLimit("100000"), MAX_LIMIT);
  for (const raw of ["-5", "0", "2.5", "abc", "Infinity"]) assert.throws(() => parseLimit(raw), ParamError, raw);
});

test("parseSince turns days into a cutoff and survives huge values", () => {
  const now = Date.parse("2026-10-18T00:00:00.000Z");
  assert.equal(parseSince(undefined, now), undefined);
  assert.equal(parseSince("", now), undefined);
  assert.equal(parseSince("0", now), undefined);
  assert.equal(parseSince("-3", now), undefined);
  assert.equal(parseSince("1", now), "2026-10-17T00:00:00.000Z");
  assert.equal(parseSince("1e300", now), new Date(now - MAX_DAYS * 86_400_000).toISOString());
  for (const raw of ["abc", "Infinity"]) assert.throws(() => parseSince(raw, now), ParamError, raw);
});
