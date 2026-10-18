import { parseHTML } from "linkedom";
import { get, tryGet, LIMITS } from "./fetcher.ts";
import { looksLikeFeed, parseFeed } from "./feed.ts";

export interface Discovery {
  mode: "feed" | "html";
  feedUrl: string | null;
  title: string | null;
}

const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5";

// Probed relative to the source URL itself (topic pages), then to the site root.
const PROBE_PATHS = [
  "feed/", "feed", "rss/", "rss", "rss.xml", "feed.xml", "atom.xml", "index.xml",
  "feeds/posts/default", "?feed=rss2",
];

function isTopicUrl(u: URL): boolean {
  return u.pathname.replace(/\/+$/, "") !== "";
}

async function isFeed(url: string): Promise<{ title: string | null } | null> {
  const res = await tryGet(url, { maxBytes: LIMITS.feedBytes, accept: FEED_ACCEPT });
  if (!res) return null;
  const body = res.text();
  if (!looksLikeFeed(body)) return null;
  try {
    const feed = parseFeed(body, res.url);
    return feed.items.length ? { title: feed.title } : null;
  } catch {
    return null;
  }
}

/**
 * Works out how to crawl a source URL: as a feed (the URL itself, an advertised
 * <link rel="alternate">, or a probed common path) or, failing that, by scraping
 * article links from the HTML page.
 *
 * For a topic/category URL only a feed scoped to that topic counts. Falling back to
 * the site-wide feed would fill the topic with unrelated posts, so HTML mode wins there.
 */
export async function discover(sourceUrl: string): Promise<Discovery> {
  const src = new URL(sourceUrl);
  const topic = isTopicUrl(src);
  const topicPath = src.pathname.replace(/\/+$/, "");

  const res = await get(sourceUrl);
  const body = res.text();

  // 1. The URL is itself a feed.
  if (looksLikeFeed(body)) {
    const feed = parseFeed(body, res.url);
    return { mode: "feed", feedUrl: res.url, title: feed.title };
  }

  const { document } = parseHTML(body);
  const siteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim();
  const docTitle = document.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim();
  // A topic page's <title> ("Kubernetes - The New Stack") says more than the site name.
  const pageTitle = (topic ? docTitle || siteName : siteName || docTitle) || src.hostname;

  // 2. Advertised feeds.
  const alternates = [...document.querySelectorAll('link[rel~="alternate"]')]
    .filter((l) => /(rss|atom)\+xml/i.test(l.getAttribute("type") ?? ""))
    .flatMap((l) => {
      // One malformed href shouldn't stop discovery; skip it and try the others.
      try {
        return [{ href: new URL(l.getAttribute("href") ?? "", res.url).href, title: l.getAttribute("title") ?? "" }];
      } catch {
        return [];
      }
    })
    .filter((l) => !/comment/i.test(l.href + l.title));

  const scoped = (href: string) => topicPath !== "" && new URL(href).pathname.startsWith(topicPath);
  const ordered = topic
    ? alternates.filter((l) => scoped(l.href))
    : alternates;
  for (const alt of ordered) {
    if (await isFeed(alt.href)) return { mode: "feed", feedUrl: alt.href, title: pageTitle };
  }

  // 3. Common feed paths, relative to the page itself first.
  const base = src.href.endsWith("/") ? src.href : `${src.href}/`;
  const candidates = PROBE_PATHS.map((p) => new URL(p, base).href);
  if (!topic) candidates.push(...PROBE_PATHS.map((p) => new URL(p, src.origin + "/").href));
  for (const href of new Set(candidates)) {
    if (await isFeed(href)) return { mode: "feed", feedUrl: href, title: pageTitle };
  }

  // 4. No usable feed: scrape the page.
  return { mode: "html", feedUrl: null, title: pageTitle };
}

// ─── HTML mode: article links on a listing page ─────────────────────────────

// Paths that look like a post rather than a section (from the old crawler, plus long slugs).
const ARTICLE_PATH_RE =
  /\/\d{4}\/|\/article\/|\/post\/|\/story\/|\/news\/|\/blog\/|\/review\/|\/guide\/|\/how-to\/|\/feature\/|\/[a-z0-9]+(?:-[a-z0-9]+){3,}\/?$|\/[a-z0-9-]{20,}\/?$/i;
const NOT_ARTICLE_RE =
  /\/(tag|tags|category|categories|author|authors|page|search|about|contact|privacy|terms|login|subscribe|newsletter|events|podcasts?|sponsors?)(\/|$)|\.(jpe?g|png|gif|webp|pdf|zip|xml)$/i;

/** Same-host article links from a listing page, most prominent (headline/article) links first. */
export async function scrapeArticleLinks(pageUrl: string, max: number): Promise<string[]> {
  const res = await get(pageUrl);
  const { document } = parseHTML(res.text());
  const host = new URL(res.url).hostname.replace(/^www\./, "");

  const prominent = [...document.querySelectorAll("article a[href], h1 a[href], h2 a[href], h3 a[href]")];
  const all = [...document.querySelectorAll("a[href]")];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of [...prominent, ...all]) {
    if (out.length >= max) break;
    if (a.closest("nav, header, footer, aside")) continue;
    let u: URL;
    try {
      u = new URL(a.getAttribute("href") ?? "", res.url);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, "") !== host) continue;
    if (!ARTICLE_PATH_RE.test(u.pathname) || NOT_ARTICLE_RE.test(u.pathname)) continue;
    u.hash = "";
    u.search = "";
    const clean = u.href;
    if (clean === res.url || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}
