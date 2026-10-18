import { test } from "node:test";
import assert from "node:assert/strict";
import { get, isPrivate, FetchError } from "../src/fetcher.ts";

test("isPrivate covers loopback, LAN and mapped forms", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "172.20.0.1", "169.254.1.1", "100.64.0.1",
    "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:c0a8:101",
    "64:ff9b::7f00:1", "not-an-ip"]) {
    assert.equal(isPrivate(ip), true, ip);
  }
  for (const ip of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:101:101"]) {
    assert.equal(isPrivate(ip), false, ip);
  }
});

test("get() refuses private targets by literal and by name", async () => {
  for (const url of ["http://[::ffff:127.0.0.1]:4600/", "http://[::ffff:7f00:1]/", "http://127.0.0.1/", "http://localhost:4600/"]) {
    await assert.rejects(get(url), (e) => e instanceof FetchError && /private/.test(e.message) && !e.temporary, url);
  }
});
