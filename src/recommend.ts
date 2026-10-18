import * as store from "./db.ts";
import type { ArticleQuery, ArticleRow, Feedback } from "./db.ts";

// "For you" ranking. Each reaction is a point in embedding space with a weight; an article
// scores by the weighted sentiment of its nearest reactions, so separate interests (say,
// Kubernetes and AI policy) each pull in their own neighbours instead of averaging out.

const NEIGHBOURS = 8;
const SIM_FLOOR = 0.2; // MiniLM puts unrelated news around 0.0–0.2
const SHRINK = 0.3; // pulls scores with only faint support toward zero
const SOURCE_WEIGHT = 0.25;
const RECENCY_WEIGHT = 0.3;
const HALF_LIFE_DAYS = 3;
const EXPLORE_EVERY = 6; // every 6th slot goes to something the profile knows little about
const EXPLORE_SUPPORT = 0.15;
export const MIN_REACTIONS = 3;

/** Thumbs count fully, a hide is a softer no, and a click alone is a mild yes. */
function weight(f: Feedback): number {
  if (f.rating) return f.rating;
  if (f.hidden) return -0.6;
  if (f.clicks) return 0.3;
  return 0;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

interface Ranked extends ArticleRow {
  score: number;
  reason: string | null;
}

// The date range narrows the candidates; sort is ignored, since this view's order is the ranking.
export function forYou({ source, q, since, limit, offset }: ArticleQuery) {
  const reactions = store
    .listFeedback()
    .map((f) => ({ ...f, w: weight(f) }))
    .filter((f) => f.w !== 0);
  const trained = reactions.filter((f) => f.embedding);
  if (trained.length < MIN_REACTIONS) {
    return { ...store.listArticles({ source, q, since, limit, offset }), coldStart: true, reactions: trained.length };
  }

  // Bayesian-ish source affinity: two phantom neutral votes keep one like from dominating.
  const bySource = new Map<number, { sum: number; n: number }>();
  for (const f of reactions) {
    if (f.source_id == null) continue;
    const s = bySource.get(f.source_id) ?? { sum: 0, n: 0 };
    s.sum += f.w;
    s.n++;
    bySource.set(f.source_id, s);
  }
  const affinity = (id: number) => {
    const s = bySource.get(id);
    return s ? s.sum / (s.n + 2) : 0;
  };

  const now = Date.now();
  const seen = new Set(reactions.map((f) => f.url));
  const ranked: (Ranked & { support: number })[] = [];
  for (const a of store.candidateArticles({ source, q, since })) {
    if (seen.has(a.url)) continue; // already rated, hidden or opened

    let rel = 0;
    let support = 0;
    let best: { title: string; pull: number } | null = null;
    if (a.embedding) {
      const near = trained
        .map((f) => ({ f, s: Math.max(0, dot(a.embedding!, f.embedding!) - SIM_FLOOR) }))
        .sort((x, y) => y.s - x.s)
        .slice(0, NEIGHBOURS);
      let pull = 0;
      for (const { f, s } of near) {
        pull += f.w * s;
        support += s;
        if (f.w > 0 && s > 0.15 && (!best || f.w * s > best.pull)) best = { title: f.title, pull: f.w * s };
      }
      rel = pull / (support + SHRINK);
    }
    const src = affinity(a.source_id);
    const ageDays = (now - Date.parse(a.published_at ?? a.fetched_at)) / 86_400_000;
    const recency = 0.5 ** (Math.max(0, ageDays) / HALF_LIFE_DAYS);
    const reason = best
      ? `Similar to “${best.title}”`
      : src > 0.25
        ? `You like ${a.source_title}`
        : null;
    ranked.push({ ...a, score: rel + SOURCE_WEIGHT * src + RECENCY_WEIGHT * recency, reason, support });
  }

  ranked.sort((x, y) => y.score - x.score);

  // Interleave fresh articles from unexplored territory so the profile keeps learning.
  const explore = ranked
    .filter((r) => r.support < EXPLORE_SUPPORT)
    .sort((x, y) => Date.parse(y.published_at ?? y.fetched_at) - Date.parse(x.published_at ?? x.fetched_at));
  const exploreIds = new Set(explore.map((r) => r.id));
  const main = ranked.filter((r) => !exploreIds.has(r.id));
  const ordered: typeof ranked = [];
  while (main.length || explore.length) {
    const pickExplore = (ordered.length + 1) % EXPLORE_EVERY === 0 ? explore : main;
    const next = (pickExplore.length ? pickExplore : pickExplore === main ? explore : main).shift()!;
    if (exploreIds.has(next.id)) next.reason = "Exploring: new territory";
    ordered.push(next);
  }

  const rows = ordered.slice(offset, offset + limit).map(({ embedding: _e, support: _s, ...r }) => r);
  return { total: ordered.length, rows, coldStart: false, reactions: trained.length };
}
