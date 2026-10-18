import * as store from "./db.ts";
import { collapses, parseKeyset, type ArticleFilter, type ArticleRow } from "./db.ts";
import { embedQuery } from "./embed.ts";
import { firstPage, nextPage } from "./snapshots.ts";

// Search by meaning, so "graphics card prices" also finds "GPU costs climb", with exact words
// still counting for a lot: an article containing every query word gets a boost, more when they're
// all in the headline. Results are ordered by relevance, not date.

export const RELATED_FLOOR = 0.4; // below this, a match without the query's words is noise
const TITLE_BOOST = 0.3;
const TEXT_BOOST = 0.15;

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

type Hit = ArticleRow & { score: number; reason: string | null };

export type SearchQuery = ArticleFilter & { q: string; limit: number; after?: string };

export async function search(query: SearchQuery) {
  const { q, limit, after, ...filter } = query;
  const cached = nextPage<Hit, null>(after, limit);
  if (cached) return { ...cached, rows: store.withCoverage(cached.rows, filter), semantic: true };

  let qv: Float32Array | null = null;
  try {
    qv = await embedQuery(q);
  } catch (e) {
    console.error("[search] embedding failed, using keyword search:", e instanceof Error ? e.message : e);
  }
  // Without the model, fall back to plain keyword matching in date order.
  if (!qv) {
    const keyword = store.listArticles({ ...filter, q, limit, after: after ? parseKeyset(after) : undefined });
    return { ...keyword, semantic: false };
  }

  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const hasAll = (text: string) => terms.length > 0 && terms.every((t) => text.includes(t));

  // Every report is searched, since a story's lead may not be the report that matches.
  const byLead = new Map<number, { score: number; reason: string | null }>();
  const rows = new Map<number, ArticleRow>();
  for (const { embedding, dup_of, ...a } of store.candidateArticles(filter)) {
    const title = a.title.toLowerCase();
    const inTitle = hasAll(title);
    const inText = inTitle || hasAll(`${title} ${(a.excerpt ?? "").toLowerCase()}`);
    const sim = embedding ? dot(qv, embedding) : 0;
    if (!inText && sim < RELATED_FLOOR) continue;
    const score = sim + (inTitle ? TITLE_BOOST : inText ? TEXT_BOOST : 0);
    const reason = inText ? null : "Related to your search";
    const lead = collapses(filter) && dup_of ? dup_of : a.id;
    const prev = byLead.get(lead);
    if (!prev || score > prev.score) byLead.set(lead, { score, reason });
    if (lead === a.id) rows.set(a.id, a);
  }
  // Leads that only matched through another report of their story.
  for (const a of store.articlesById([...byLead.keys()].filter((id) => !rows.has(id)))) rows.set(a.id, a);

  const hits: Hit[] = [...byLead]
    .filter(([id]) => rows.has(id))
    .map(([id, h]) => ({ ...rows.get(id)!, ...h }))
    .sort((x, y) => y.score - x.score);
  const page = firstPage(hits, null, limit);
  return { ...page, rows: store.withCoverage(page.rows, filter), semantic: true };
}
