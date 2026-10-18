import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed } from "../src/feed.ts";

test("parseFeed keeps only http(s) article and image links", () => {
  const xml = `<rss version="2.0"><channel><title>T</title>
    <item><title>Hostile</title><link>javascript:fetch('/api/sources/1',{method:'DELETE'})</link></item>
    <item><title>Data</title><link>data:text/html,hi</link></item>
    <item><title>Relative</title><link>/posts/1</link>
      <enclosure url="javascript:alert(1)" type="image/png"/></item>
  </channel></rss>`;
  const { items } = parseFeed(xml, "https://example.com/feed.xml");
  assert.deepEqual(items.map((i) => i.url), ["https://example.com/posts/1"]);
  assert.equal(items[0].image, null);
});
