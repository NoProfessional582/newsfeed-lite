import { XMLParser } from "fast-xml-parser";

export interface FeedItem {
  url: string;
  title: string | null;
  summaryHtml: string | null;
  author: string | null;
  publishedAt: string | null; // ISO, or null when missing/unrepresentable
  image: string | null;
}

export interface Feed {
  title: string | null;
  items: FeedItem[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  removeNSPrefix: false,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) =>
    ["item", "entry", "link", "media:content", "media:thumbnail", "enclosure", "category"].includes(name),
});

type Node = Record<string, unknown>;

/** Text content of a node that may be a string, a {#text} object, or a CDATA wrapper. */
function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text((v as Node)["#text"]);
  return null;
}

/** A date we can store, or null. Rejects the year-0 style junk some feeds emit. */
function isoDate(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  const y = d.getUTCFullYear();
  if (Number.isNaN(d.getTime()) || y < 1990 || d.getTime() > Date.now() + 2 * 86_400_000) return null;
  return d.toISOString();
}

function firstImgSrc(html: string | null): string | null {
  if (!html) return null;
  return /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1] ?? null;
}

/** Same lookup order as the old crawler: media:thumbnail, media:content, image enclosure, itunes, first <img>. */
function itemImage(item: Node, html: string | null): string | null {
  const thumbs = item["media:thumbnail"] as Node[] | undefined;
  if (thumbs?.[0]?.["@url"]) return String(thumbs[0]["@url"]);
  const group = item["media:group"] as Node | undefined;
  const media = [
    ...((item["media:content"] as Node[] | undefined) ?? []),
    ...((group?.["media:content"] as Node[] | undefined) ?? []),
  ];
  for (const m of media) {
    const type = String(m["@type"] ?? m["@medium"] ?? "image");
    if (m["@url"] && /image/.test(type)) return String(m["@url"]);
  }
  for (const e of (item["enclosure"] as Node[] | undefined) ?? []) {
    if (String(e["@type"] ?? "").startsWith("image/") && e["@url"]) return String(e["@url"]);
  }
  // Atom: <link rel="enclosure" type="image/...">
  for (const l of (item["link"] as Node[] | undefined) ?? []) {
    if (typeof l === "object" && l["@rel"] === "enclosure" && String(l["@type"] ?? "").startsWith("image/")) {
      return String(l["@href"]);
    }
  }
  const itunes = item["itunes:image"] as Node | undefined;
  if (itunes?.["@href"]) return String(itunes["@href"]);
  return firstImgSrc(html);
}

function atomLink(links: unknown): string | null {
  const list = (Array.isArray(links) ? links : [links]) as (Node | string)[];
  const alt = list.find((l) => typeof l === "object" && (!l["@rel"] || l["@rel"] === "alternate"));
  if (alt && typeof alt === "object") return String(alt["@href"] ?? "") || null;
  return text(list[0]);
}

export function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 2000).toLowerCase();
  return /<rss[\s>]|<feed[\s>]|<rdf:rdf[\s>]/.test(head);
}

/** Parses RSS 2.0, RSS 1.0 (RDF) and Atom. Throws if the document isn't a feed. */
export function parseFeed(xml: string, baseUrl: string): Feed {
  const doc = parser.parse(xml) as Node;
  const resolve = (u: string | null) => {
    if (!u) return null;
    try {
      return new URL(u, baseUrl).href;
    } catch {
      return null;
    }
  };

  let title: string | null = null;
  let raw: Node[] = [];
  let atom = false;

  if (doc.rss) {
    const channel = (doc.rss as Node).channel as Node;
    title = text(channel?.title);
    raw = (channel?.item as Node[]) ?? [];
  } else if (doc["rdf:RDF"]) {
    const rdf = doc["rdf:RDF"] as Node;
    title = text((rdf.channel as Node)?.title);
    raw = (rdf.item as Node[]) ?? [];
  } else if (doc.feed) {
    atom = true;
    const feed = doc.feed as Node;
    title = text(feed.title);
    raw = (feed.entry as Node[]) ?? [];
  } else {
    throw new Error("document is not an RSS or Atom feed");
  }

  const items: FeedItem[] = [];
  for (const item of raw) {
    // One malformed entry costs that entry, not the whole feed.
    try {
      const url = resolve(atom ? atomLink(item.link) : text(item.link) ?? text(item.guid));
      if (!url) continue;
      const summaryHtml =
        text(item.description) ?? text(item.summary) ?? text(item["content:encoded"]) ?? text(item.content);
      const contentHtml = text(item["content:encoded"]) ?? text(item.content);
      const authorNode = item.author as Node | string | undefined;
      const author =
        text(item["dc:creator"]) ??
        (typeof authorNode === "object" ? text(authorNode?.name) : text(authorNode));
      items.push({
        url,
        title: text(item.title),
        summaryHtml,
        author,
        publishedAt: isoDate(item.pubDate ?? item.published ?? item["dc:date"] ?? item.updated),
        image: resolve(itemImage(item, contentHtml ?? summaryHtml)),
      });
    } catch {
      continue;
    }
  }
  return { title, items };
}
