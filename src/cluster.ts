import * as store from "./db.ts";
import type { ClusterInput } from "./db.ts";

// Groups reports of the same story from different sites, so the feed shows one card with "also
// covered by" links instead of three near-identical ones. Each new article joins the closest
// earlier one if the pair scores high enough; otherwise it starts its own story.
//
// Embeddings alone don't separate "same story" from "same topic": on real data, the same news from
// two sites scored 0.60–0.83 while unrelated pieces about AI or Docker scored up to 0.69. Adding
// the overlap of rare title words (SpaceX, Muse Spark, Full Disk Access) does separate them, so
// the score is similarity + OVERLAP_WEIGHT × overlap. The threshold is deliberately strict:
// wrongly hiding a different story behind a link costs more than showing a duplicate.

const THRESHOLD = 0.93;
const OVERLAP_WEIGHT = 0.4;
const MIN_SIMILARITY = 0.55; // skip the title math for pairs that are clearly unrelated
const WINDOW_MS = 3 * 86_400_000; // coverage of one story lands within a few days

const STOP = new Set(
  ("the and for with that this from your you are was has have its into over about after what how why who new now " +
    "just more than most will can not but our out all one get got use using here heres says said these those they " +
    "them their when where which while been being also very ways things thing every best")
    .split(" "),
);

/** Significant title words: lowercase, no stopwords, crude plural folding ("chips" = "chip"). */
export function titleWords(title: string): Set<string> {
  const words = title.toLowerCase().normalize("NFKD").match(/[a-z0-9][a-z0-9.\-]*[a-z0-9]|[a-z0-9]/g) ?? [];
  return new Set(words.filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.replace(/s$/, "")));
}

const host = (u: string) => new URL(u).hostname.replace(/^www\./, "");

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Assigns every article that hasn't been considered yet to a story. Returns how many joined one. */
export function clusterPending(): number {
  const all = store.clusterInputs();
  if (!all.some((a) => !a.clustered)) return 0;

  // Rare words say more than common ones: "nvidia" appears in many titles, "metr" in one story.
  const words = new Map(all.map((a) => [a.id, titleWords(a.title)]));
  const df = new Map<string, number>();
  for (const ws of words.values()) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log(all.length / (df.get(w) ?? 1));
  const mass = (ws: Iterable<string>) => [...ws].reduce((n, w) => n + idf(w), 0);
  const overlap = (a: ClusterInput, b: ClusterInput) => {
    const wa = words.get(a.id)!;
    const wb = words.get(b.id)!;
    const shared = [...wa].filter((w) => wb.has(w));
    const denom = Math.min(mass(wa), mass(wb));
    return denom > 0 ? mass(shared) / denom : 0;
  };

  let joined = 0;
  const earlier: ClusterInput[] = [];
  for (const a of all) {
    if (a.clustered) {
      earlier.push(a);
      continue;
    }
    const t = Date.parse(a.date);
    const h = host(a.url);
    let best: { lead: number; score: number } | null = null;
    for (const b of earlier) {
      // Same-site pairs are a publisher's own follow-ups or topic overlap, not the same report twice.
      if (host(b.url) === h || Math.abs(Date.parse(b.date) - t) > WINDOW_MS) continue;
      const sim = dot(a.embedding, b.embedding);
      if (sim < MIN_SIMILARITY) continue;
      const score = sim + OVERLAP_WEIGHT * overlap(a, b);
      if (score >= THRESHOLD && (!best || score > best.score)) best = { lead: b.dup_of ?? b.id, score };
    }
    store.setCluster(a.id, best?.lead ?? null);
    a.dup_of = best?.lead ?? null;
    a.clustered = 1;
    earlier.push(a);
    if (best) joined++;
  }
  if (joined) console.log(`[cluster] ${joined} articles joined an existing story`);
  return joined;
}
