import { config } from "./config.ts";
import * as store from "./db.ts";
import type { Source } from "./db.ts";
import { discover, scrapeArticleLinks } from "./discover.ts";
import { parseFeed, type FeedItem } from "./feed.ts";
import { get, LIMITS } from "./fetcher.ts";
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
  store.updateSource(source.id, { mode: d.mode, feed_url: d.feedUrl, title: source.title ?? d.title, last_error: null });
  return store.getSource(source.id)!;
}

async function ingest(source: Source, url: string, item?: FeedItem): Promise<boolean> {
  if (store.articleExists(url)) return false;
  const preview = await extractPreview(url, item);
  if (!preview) return false;
  if (preview.url !== url && store.articleExists(preview.url)) return false;

  const image = preview.imageUrl ? await saveThumbnail(preview.imageUrl, preview.url) : null;
  return store.insertArticle({
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
}

/** Crawls one source. Returns the number of new articles. Errors are recorded on the source. */
export async function crawlSource(source: Source): Promise<number> {
  try {
    if (!source.mode) source = await discoverSource(source);
    const max = config.maxArticlesPerSource;
    const cutoff = Date.now() - config.retentionDays * 86_400_000;

    let jobs: Promise<boolean>[];
    if (source.mode === "feed" && source.feed_url) {
      const res = await get(source.feed_url, { maxBytes: LIMITS.feedBytes });
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
    const failed = results.filter((r) => r.status === "rejected").length;
    store.updateSource(source.id, {
      last_crawled_at: now(),
      last_error: failed && !added && failed === results.length ? `all ${failed} articles failed` : null,
    });
    return added;
  } catch (e) {
    // Forget the cached discovery so the next run re-detects (feeds move, sites redesign).
    store.updateSource(source.id, { last_crawled_at: now(), last_error: message(e), mode: null, feed_url: null });
    return 0;
  }
}

/** Crawls every enabled source, then prunes old articles. No-op if a run is in progress. */
export async function crawlAll(): Promise<boolean> {
  if (status.running) return false;
  const sources = store.listSources().filter((s) => s.enabled);
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
