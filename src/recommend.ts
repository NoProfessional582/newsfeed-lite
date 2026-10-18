import * as store from "./db.ts";
import { parseKeyset, type ArticleFilter, type Feedback, type RankableRow } from "./db.ts";
import { firstPage, nextPage } from "./snapshots.ts";

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

/** Thumbs count fully, a hide is a softer no, saving is a fair yes and a click alone a mild one. */
function weight(f: Feedback): number {
  if (f.rating) return f.rating;
  if (f.hidden) return -0.6;
  if (f.saved) return 0.5;
  if (f.clicks) return 0.3;
  return 0;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

type Weighted = Feedback & { w: number };

function weightedReactions(): Weighted[] {
  return store
    .listFeedback()
    .map((f) => ({ ...f, w: weight(f) }))
    .filter((f) => f.w !== 0);
}

/** Bayesian-ish source affinity: two phantom neutral votes keep one like from dominating. */
function sourceAffinity(reactions: Weighted[]) {
  const bySource = new Map<number, { sum: number; n: number }>();
  for (const f of reactions) {
    if (f.source_id == null) continue;
    const s = bySource.get(f.source_id) ?? { sum: 0, n: 0 };
    s.sum += f.w;
    s.n++;
    bySource.set(f.source_id, s);
  }
  return {
    bySource,
    affinity: (id: number) => {
      const s = bySource.get(id);
      return s ? s.sum / (s.n + 2) : 0;
    },
  };
}

type RankedRow = Omit<RankableRow, "embedding"> & { score: number; reason: string | null };

export type ForYouQuery = Omit<ArticleFilter, "q" | "saved"> & { limit: number; after?: string };

// The date range narrows the candidates; sort is ignored, since this view's order is the ranking.
// Only a story's first report is ranked; its other reports ride along as coverage.
export function forYou(query: ForYouQuery) {
  const { limit, after, ...filter } = query;
  const cached = nextPage<RankedRow, { reactions: number }>(after, limit);
  if (cached) {
    const { meta, ...page } = cached;
    return { ...page, rows: store.withCoverage(page.rows, filter), coldStart: false, reactions: meta.reactions };
  }
  // A "key|id" cursor comes from a cold-start page (the plain latest list), so keep paging that list.
  const keyset = after ? parseKeyset(after) : undefined;

  const reactions = weightedReactions();
  const trained = reactions.filter((f) => f.embedding);
  if (trained.length < MIN_REACTIONS || keyset) {
    const latest = store.listArticles({ ...filter, limit, after: keyset });
    return { ...latest, coldStart: trained.length < MIN_REACTIONS, reactions: trained.length };
  }

  const { affinity } = sourceAffinity(reactions);
  const now = Date.now();
  const seen = new Set(reactions.map((f) => f.url));
  const ranked: (RankedRow & { support: number })[] = [];
  for (const { embedding, ...a } of store.candidateArticles(filter, { leadsOnly: true })) {
    if (seen.has(a.url)) continue; // already rated, hidden, saved or opened

    let rel = 0;
    let support = 0;
    let best: { title: string; pull: number } | null = null;
    if (embedding) {
      const near = trained
        .map((f) => ({ f, s: Math.max(0, dot(embedding, f.embedding!) - SIM_FLOOR) }))
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

  const rows: RankedRow[] = ordered.map(({ support: _s, ...r }) => r);
  const { meta, ...page } = firstPage(rows, { reactions: trained.length }, limit);
  return { ...page, rows: store.withCoverage(page.rows, filter), coldStart: false, reactions: meta.reactions };
}

// ─── Profile ────────────────────────────────────────────────────────────────

/** What the ranking has learned, for the profile page: counts, tags and sources you lean toward. */
export function profile() {
  const all = store.listFeedback();
  const reactions = weightedReactions();
  const { bySource, affinity } = sourceAffinity(reactions);
  const titles = new Map(store.listSources().map((s) => [s.id, s.title || new URL(s.url).hostname]));

  // Feed tags summed by reaction weight; a tag needs two reactions before it says anything.
  const tags = new Map<string, { sum: number; n: number }>();
  for (const f of reactions) {
    for (const t of f.categories ? (JSON.parse(f.categories) as string[]) : []) {
      const s = tags.get(t) ?? { sum: 0, n: 0 };
      s.sum += f.w;
      s.n++;
      tags.set(t, s);
    }
  }
  const tagList = [...tags].filter(([, s]) => s.n >= 2).map(([tag, s]) => ({ tag, score: s.sum, n: s.n }));

  return {
    counts: {
      up: all.filter((f) => f.rating === 1).length,
      down: all.filter((f) => f.rating === -1).length,
      hidden: all.filter((f) => f.hidden).length,
      opened: all.filter((f) => f.clicks > 0).length,
      saved: all.filter((f) => f.saved).length,
    },
    minReactions: MIN_REACTIONS,
    trained: reactions.filter((f) => f.embedding).length,
    likedTags: tagList.filter((t) => t.score > 0).sort((a, b) => b.score - a.score).slice(0, 12),
    dislikedTags: tagList.filter((t) => t.score < 0).sort((a, b) => a.score - b.score).slice(0, 12),
    sources: [...bySource]
      .map(([id, s]) => ({ id, title: titles.get(id) ?? "Removed source", affinity: affinity(id), n: s.n }))
      .sort((a, b) => b.affinity - a.affinity),
    reactions: store.listReactions(),
  };
}
