import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { tryGet } from "./fetcher.ts";
import type { FeedItem } from "./feed.ts";

export interface Preview {
  url: string; // canonical
  title: string;
  excerpt: string | null;
  imageUrl: string | null;
  author: string | null;
  publishedAt: string | null;
}

const EXCERPT_MAX = 400;
const MIN_SUMMARY = 250;

function stripSuffix(title: string, siteName: string): string {
  for (const sep of [" | ", " - ", " – ", " — ", " · ", " \\ "]) {
    if (title.toLowerCase().endsWith((sep + siteName).toLowerCase())) {
      return title.slice(0, -(sep + siteName).length);
    }
  }
  return title;
}

export function htmlToText(html: string | null): string {
  if (!html) return "";
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Trim to max chars, ending on a sentence boundary when one is reasonably close. */
export function clip(text: string, max = EXCERPT_MAX): string {
  text = text.replace(/\s+/g, " ").trim();
  // Feeds often append "The post X appeared first on Y." or "Continue reading…".
  text = text.replace(/\s*(The post .+ appeared first on .+\.?|Continue reading.*|Read more.*|\[…\]|\[\.\.\.\])\s*$/i, "");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end > max * 0.5) return cut.slice(0, end + 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\s]+$/, "") + "…";
}

function meta(document: Document, ...names: string[]): string | null {
  for (const n of names) {
    const el =
      document.querySelector(`meta[property="${n}"]`) ?? document.querySelector(`meta[name="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return null;
}

function safeIso(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1990 ? null : d.toISOString();
}

function absolute(u: string | null | undefined, base: string): string | null {
  if (!u) return null;
  try {
    const r = new URL(u, base);
    return r.protocol.startsWith("http") ? r.href : null;
  } catch {
    return null;
  }
}

/** First three substantial paragraphs of the readable article body. */
function readableLead(document: Document): string | null {
  try {
    const article = new Readability(document.cloneNode(true) as Document, { charThreshold: 300 }).parse();
    if (!article?.content) return null;
    const { document: body } = parseHTML(`<!doctype html><body>${article.content}</body>`);
    const paras = [...body.querySelectorAll("p")]
      .map((p) => (p.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 60);
    const lead = paras.slice(0, 3).join(" ");
    return lead || (article.excerpt ?? null);
  } catch {
    return null;
  }
}

/**
 * Builds a preview for one article. Feed fields are used first and the article page
 * fills the gaps; if the page can't be fetched, a feed item alone is still enough.
 */
export async function extractPreview(url: string, item?: FeedItem): Promise<Preview | null> {
  const feedSummary = htmlToText(item?.summaryHtml ?? null);
  const res = await tryGet(url);

  if (!res || !/html/i.test(res.contentType)) {
    if (!item?.title) return null;
    return {
      url,
      title: item.title,
      excerpt: feedSummary ? clip(feedSummary) : null,
      imageUrl: item.image,
      author: item.author,
      publishedAt: item.publishedAt,
    };
  }

  const { document } = parseHTML(res.text());
  const pageUrl = res.url;
  const canonical = absolute(document.querySelector('link[rel="canonical"]')?.getAttribute("href"), pageUrl);

  const rawTitle =
    meta(document, "og:title", "twitter:title") ??
    document.querySelector("h1")?.textContent?.trim() ??
    item?.title ??
    document.querySelector("title")?.textContent?.trim() ??
    null;
  if (!rawTitle) return null;
  // "Singapore office | Anthropic" -> "Singapore office"
  const siteName = meta(document, "og:site_name");
  const title = siteName ? stripSuffix(rawTitle, siteName) : rawTitle;

  // Prefer a substantial feed summary or meta description. When both are short teasers,
  // the article's own opening paragraphs make a better preview.
  const og = meta(document, "og:description", "twitter:description", "description") ?? "";
  const best = og.length > feedSummary.length ? og : feedSummary;
  let excerpt: string | null = best || null;
  if (best.length < MIN_SUMMARY) {
    const lead = readableLead(document);
    if (lead && lead.length > best.length) excerpt = lead;
  }

  const imageUrl =
    absolute(meta(document, "og:image", "og:image:url", "twitter:image", "twitter:image:src"), pageUrl) ??
    item?.image ??
    absolute(document.querySelector("article img[src], main img[src]")?.getAttribute("src"), pageUrl);

  return {
    // Some sites set every page's canonical to the homepage; ignore that.
    url: canonical && new URL(canonical).pathname.length > 1 ? canonical : pageUrl,
    title: title.replace(/\s+/g, " ").trim(),
    excerpt: excerpt ? clip(excerpt) : null,
    imageUrl,
    author: item?.author ?? meta(document, "author", "article:author"),
    publishedAt:
      item?.publishedAt ??
      safeIso(meta(document, "article:published_time", "datePublished", "date")) ??
      safeIso(document.querySelector("time[datetime]")?.getAttribute("datetime") ?? null),
  };
}
