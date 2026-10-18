import { config } from "./config.ts";
import * as store from "./db.ts";
import type { Source } from "./db.ts";
import { discover, scrapeArticleLinks } from "./discover.ts";
import { parseFeed, type FeedItem } from "./feed.ts";
import { get, startRun, FetchError, LIMITS } from "./fetcher.ts";
import { extractPreview } from "./extract.ts";
import { saveThumbnail, deleteImages } from "./images.ts";
import { embedPending } from "./embed.ts";

export const status = {
  running: false,
  startedAt: null as string | null,
  lastRunAt: null as string | null,
  lastRunNew: 0,
  sourcesDone: 0,
  sourcesTotal: 0,
};

const now = () => new Date().toISOString();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Runs discovery for a source and stores the result. */
export async function discoverSource(source: Source): Promise<Source> {
  const d = await discover(source.url);
  store.updateSource(source.id, {
    mode: d.mode,
    feed_url: d.feedUrl,
    title: source.title ?? d.title,
    last_error: null,
    etag: null, // validators belong to the old feed URL
    last_modified: null,
  });
  return store.getSource(source.id)!;
}

/** True for an absolute http(s) URL, the only kind an article may link to. */
const isWebUrl = (u: string) => /^https?:\/\//i.test(u);

async function ingest(source: Source, url: string, item?: FeedItem): Promise<boolean> {
  if (!isWebUrl(url) || store.touchSeen(url)) return false;
  const preview = await extractPreview(url, item);
  if (!preview || !isWebUrl(preview.url)) return false;
  if (preview.url !== url && store.touchSeen(preview.url)) {
    store.markSeen([url], source.id); // so the next run skips this link without fetching it
    return false;
  }

  const image = preview.imageUrl ? await saveThumbnail(preview.imageUrl, preview.url) : null;
  const added = store.insertArticle({
    source_id: source.id,
    url: preview.url,
    title: preview.title.slice(0, 500),
    excerpt: preview.excerpt,
    image_path: image,
    image_url: preview.imageUrl,
    author: preview.author,
    published_at: preview.publishedAt,
    categories: preview.categories.length ? JSON.stringify(preview.categories) : null,
  });
  store.markSeen([url, preview.url], source.id);
  return added;
}

/** Crawls one source. Returns the number of new articles. Errors are recorded on the source. */
export async function crawlSource(source: Source): Promise<number> {
  try {
    if (!source.mode) source = await discoverSource(source);
    const max = config.maxArticlesPerSource;
    const cutoff = Date.now() - config.retentionDays * 86_400_000;

    let jobs: Promise<boolean>[];
    let validators: Pick<Source, "etag" | "last_modified"> = { etag: null, last_modified: null };
    if (source.mode === "feed" && source.feed_url) {
      // A conditional GET: an unchanged feed answers 304 with no body.
      const headers: Record<string, string> = {};
      if (source.etag) headers["If-None-Match"] = source.etag;
      if (source.last_modified) headers["If-Modified-Since"] = source.last_modified;
      const res = await get(source.feed_url, { maxBytes: LIMITS.feedBytes, headers });
      if (res.status === 304) {
        store.updateSource(source.id, { last_crawled_at: now(), last_error: null });
        store.recordSourceRun(source.id, true);
        return 0;
      }
      validators = { etag: res.header("etag"), last_modified: res.header("last-modified") };
      const feed = parseFeed(res.text(), res.url);
      const items = feed.items
        .slice(0, max)
        // Old posts would be pruned right after insert and refetched next run.
        .filter((i) => !i.publishedAt || Date.parse(i.publishedAt) >= cutoff);
      jobs = items.map((i) => ingest(source, i.url, i));
    } else {
      const links = await scrapeArticleLinks(source.url, max);
      jobs = links.map((u) => ingest(source, u));
    }

    // One failed article costs that article, not the source.
    const results = await Promise.allSettled(jobs);
    const added = results.filter((r) => r.status === "fulfilled" && r.value).length;
    const rejected = results.filter((r) => r.status === "rejected");
    const failed = rejected.length;
    const allFailed = failed > 0 && !added && failed === results.length;
    store.updateSource(source.id, {
      last_crawled_at: now(),
      last_error: allFailed ? `all ${failed} articles failed: ${message(rejected[0].reason)}` : null,
      // Keep the validators only if every item was dealt with. Items skipped over a request budget
      // or rate limit must be retried next run, and a 304 would hide them.
      ...(failed ? { etag: null, last_modified: null } : validators),
    });
    store.recordSourceRun(source.id, !allFailed);
    return added;
  } catch (e) {
    // A rate limit, outage or timeout says nothing about the feed, so keep it. Anything else
    // forgets the cached discovery so the next run re-detects (feeds move, sites redesign).
    const keep = e instanceof FetchError && e.temporary;
    store.updateSource(source.id, {
      last_crawled_at: now(),
      last_error: message(e),
      ...(keep ? {} : { mode: null, feed_url: null, etag: null, last_modified: null }),
    });
    store.recordSourceRun(source.id, false);
    return 0;
  }
}

/** Crawls every enabled source, then prunes old articles. No-op if a run is in progress. */
export async function crawlAll(): Promise<boolean> {
  if (status.running) return false;
  const sources = store.listSources().filter((s) => s.enabled);
  startRun();
  Object.assign(status, { running: true, startedAt: now(), sourcesDone: 0, sourcesTotal: sources.length });
  let added = 0;
  try {
    await Promise.all(
      sources.map(async (s) => {
        const n = await crawlSource(s); // not `added += await …`, which reads `added` before awaiting
        added += n;
        status.sourcesDone++;
      }),
    );
    await deleteImages(store.pruneArticles(config.retentionDays));
    // Ranking just skips unembedded articles, so a model failure shouldn't fail the crawl.
    await embedPending().catch((e) => console.error("[embed] failed:", message(e)));
  } finally {
    Object.assign(status, { running: false, lastRunAt: now(), lastRunNew: added });
    console.log(`[crawl] ${sources.length} sources, ${added} new articles`);
  }
  return true;
}
