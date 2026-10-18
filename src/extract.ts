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
  categories: string[];
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

/** article:tag metas, for pages scraped without a feed. */
function pageTags(document: Document): string[] {
  const tags = [...document.querySelectorAll('meta[property="article:tag"]')]
    .map((m) => m.getAttribute("content")?.trim().toLowerCase())
    .filter((t): t is string => !!t && t.length <= 60);
  return [...new Set(tags)].slice(0, 12);
}

const BIO_ROLE = /\b(writer|journalist|author|editor|reporter|contributor|columnist|freelancer|tech enthusiast)\b/i;

/**
 * True for an author blurb rather than article text. Some templates (Valnet's How-To Geek and XDA)
 * put the byline's bio in the article header as plain paragraphs, which Readability then picks as
 * the article. A bio opens with the author's name ("Ismar is a Senior Author…", "Umair Khurshid is
 * a technology writer…"), or with any name followed by "is a … writer/journalist/…".
 */
export function looksLikeBio(text: string, author: string | null): boolean {
  const start = text.trim().slice(0, 200);
  const name = (author ?? "").replace(/^.*\(|\)$/g, "").trim(); // "staff@bgr.com (Jane Doe)" -> "Jane Doe"
  const first = name.split(/\s+/)[0];
  for (const n of new Set([name, first])) {
    if (n.length >= 2 && start.toLowerCase().startsWith(n.toLowerCase()) && /^\s*(is|has|was|’s|'s)\b/i.test(start.slice(n.length))) {
      return true;
    }
  }
  const lead = /^(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){0,2})\s+is\s+an?\s+([^.]{0,80})/u.exec(start);
  return !!lead && BIO_ROLE.test(lead[2]);
}

const paragraphs = (root: ParentNode, author: string | null) =>
  [...root.querySelectorAll("p")]
    .map((p) => (p.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 60 && !looksLikeBio(t, author));

// Containers that sites mark up as the article itself. When one has real paragraphs it beats
// Readability's guess, which can land on a header bio or a related-posts block instead.
const BODY_SELECTORS = [
  '[itemprop="articleBody"]', "#article-body", ".article-body", ".article__body", ".entry-content", ".post-content",
];

/** First three substantial paragraphs of the article body. */
function articleLead(document: Document, author: string | null): string | null {
  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    const paras = el ? paragraphs(el, author) : [];
    if (paras.length >= 2) return paras.slice(0, 3).join(" ");
  }
  try {
    const article = new Readability(document.cloneNode(true) as Document, { charThreshold: 300 }).parse();
    if (!article?.content) return null;
    const { document: body } = parseHTML(`<!doctype html><body>${article.content}</body>`);
    const lead = paragraphs(body, author).slice(0, 3).join(" ");
    const excerpt = article.excerpt && !looksLikeBio(article.excerpt, author) ? article.excerpt : null;
    return lead || excerpt;
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
      excerpt: feedSummary && !looksLikeBio(feedSummary, item.author) ? clip(feedSummary) : null,
      imageUrl: item.image,
      author: item.author,
      publishedAt: item.publishedAt,
      categories: item.categories,
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

  const author = item?.author ?? meta(document, "author", "article:author");

  // Prefer a substantial feed summary or meta description. When both are short teasers,
  // the article's own opening paragraphs make a better preview. A summary that is really the
  // author's bio doesn't count.
  const usable = (s: string) => (s && !looksLikeBio(s, author) ? s : "");
  const og = usable(meta(document, "og:description", "twitter:description", "description") ?? "");
  const summary = usable(feedSummary);
  const best = og.length > summary.length ? og : summary;
  let excerpt: string | null = best || null;
  if (best.length < MIN_SUMMARY) {
    const lead = articleLead(document, author);
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
    author,
    publishedAt:
      item?.publishedAt ??
      safeIso(meta(document, "article:published_time", "datePublished", "date")) ??
      safeIso(document.querySelector("time[datetime]")?.getAttribute("datetime") ?? null),
    categories: item?.categories.length ? item.categories : pageTags(document),
  };
}
