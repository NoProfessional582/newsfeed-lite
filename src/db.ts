import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export interface Source {
  id: number;
  url: string;
  title: string | null;
  feed_url: string | null;
  mode: "feed" | "html" | null;
  enabled: number;
  last_crawled_at: string | null;
  last_error: string | null;
  /** Last run that worked; null if none ever has. */
  last_ok_at: string | null;
  /** Consecutive failed runs. */
  fail_streak: number;
  /** Validators from the last full feed fetch, sent back so an unchanged feed costs a 304. */
  etag: string | null;
  last_modified: string | null;
  article_count?: number;
}

export interface Article {
  id: number;
  source_id: number;
  url: string;
  title: string;
  excerpt: string | null;
  image_path: string | null;
  image_url: string | null;
  author: string | null;
  published_at: string | null;
  categories: string | null; // JSON array
  fetched_at: string;
}

export type NewArticle = Omit<Article, "id" | "fetched_at">;

/** Your reaction to one article, keyed by URL. It keeps its own copy of the article's text and
 *  embedding so the profile survives retention pruning. */
export interface Feedback {
  url: string;
  rating: -1 | 0 | 1;
  hidden: number;
  clicks: number;
  saved: number;
  source_id: number | null;
  title: string;
  categories: string | null;
  embedding: Float32Array | null;
}

export const db = new DatabaseSync(join(DATA_DIR, "newsfeed.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sources (
    id              INTEGER PRIMARY KEY,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT,
    feed_url        TEXT,
    mode            TEXT CHECK (mode IN ('feed', 'html')),
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_crawled_at TEXT,
    last_error      TEXT
  );

  CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY,
    source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url          TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    excerpt      TEXT,
    image_path   TEXT,
    image_url    TEXT,
    author       TEXT,
    published_at TEXT,
    fetched_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS articles_sort ON articles (coalesce(published_at, fetched_at) DESC);
  CREATE INDEX IF NOT EXISTS articles_source ON articles (source_id);

  CREATE TABLE IF NOT EXISTS feedback (
    url          TEXT PRIMARY KEY,
    rating       INTEGER NOT NULL DEFAULT 0 CHECK (rating IN (-1, 0, 1)),
    hidden       INTEGER NOT NULL DEFAULT 0,
    clicks       INTEGER NOT NULL DEFAULT 0,
    source_id    INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    title        TEXT NOT NULL,
    excerpt      TEXT,
    categories   TEXT,
    embedding    BLOB,
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Every URL a crawl has stored an article under: canonical URLs and the feed or page links that led
  -- to them. Checking it first means a link whose canonical differs isn't refetched every run, and it
  -- outlives article pruning so an old link still on a feed or page isn't ingested again as new.
  -- seen_at moves forward whenever the link shows up again; rows not seen for retentionDays are pruned.
  CREATE TABLE IF NOT EXISTS seen_urls (
    url       TEXT PRIMARY KEY,
    source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
    seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  INSERT OR IGNORE INTO seen_urls (url, source_id) SELECT url, source_id FROM articles;
`);

// Columns added after the first release. `backfill` runs once, right after the column is added.
function addColumns(table: string, columns: Record<string, string>, backfill?: string): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  const missing = Object.entries(columns).filter(([name]) => !have.has(name));
  for (const [name, type] of missing) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  if (missing.length && backfill) db.exec(backfill);
}
addColumns("articles", { categories: "TEXT", embedding: "BLOB" });
// dup_of points a later report of a story at the first one stored; see cluster.ts.
addColumns("articles", { dup_of: "INTEGER REFERENCES articles(id) ON DELETE SET NULL", clustered: "INTEGER NOT NULL DEFAULT 0" });
addColumns("feedback", { saved: "INTEGER NOT NULL DEFAULT 0", saved_at: "TEXT" });
addColumns(
  "sources",
  { last_ok_at: "TEXT", fail_streak: "INTEGER NOT NULL DEFAULT 0", etag: "TEXT", last_modified: "TEXT" },
  `UPDATE sources SET last_ok_at = last_crawled_at WHERE last_error IS NULL;
   UPDATE sources SET fail_streak = 1 WHERE last_error IS NOT NULL`,
);
db.exec(`CREATE INDEX IF NOT EXISTS articles_dup ON articles (dup_of) WHERE dup_of IS NOT NULL`);

const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
// Copy, since a BLOB's byteOffset isn't guaranteed to be 4-byte aligned.
const fromBlob = (b: Uint8Array | null) => (b ? new Float32Array(b.slice().buffer) : null);

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

// ─── Sources ────────────────────────────────────────────────────────────────

export function listSources(): Source[] {
  return db
    .prepare(
      `SELECT s.*, (SELECT count(*) FROM articles a WHERE a.source_id = s.id) AS article_count
       FROM sources s ORDER BY coalesce(s.title, s.url)`,
    )
    .all() as unknown as Source[];
}

export function getSource(id: number): Source | undefined {
  return db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id) as unknown as Source | undefined;
}

export function insertSource(url: string): Source {
  db.prepare(`INSERT INTO sources (url) VALUES (?) ON CONFLICT(url) DO NOTHING`).run(url);
  return db.prepare(`SELECT * FROM sources WHERE url = ?`).get(url) as unknown as Source;
}

export function updateSource(id: number, fields: Partial<Omit<Source, "id">>): void {
  const keys = Object.keys(fields).filter((k) => k !== "article_count");
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (fields as Record<string, string | number | null>)[k]);
  db.prepare(`UPDATE sources SET ${sets} WHERE id = ?`).run(...values, id);
}

/** Records the outcome of a crawl run for a source's health. */
export function recordSourceRun(id: number, ok: boolean): void {
  db.prepare(
    ok
      ? `UPDATE sources SET last_ok_at = ${NOW}, fail_streak = 0 WHERE id = ?`
      : `UPDATE sources SET fail_streak = fail_streak + 1 WHERE id = ?`,
  ).run(id);
}

export function deleteSource(id: number): string[] {
  const images = imagePathsWhere(`source_id = ?`, id);
  db.prepare(`DELETE FROM sources WHERE id = ?`).run(id);
  return images;
}

// ─── Articles ───────────────────────────────────────────────────────────────

/** True if a crawl has seen this URL before. Also marks it as seen again, so it isn't pruned. */
export function touchSeen(url: string): boolean {
  return db.prepare(`UPDATE seen_urls SET seen_at = ${NOW} WHERE url = ?`).run(url).changes > 0;
}

export function markSeen(urls: string[], sourceId: number): void {
  const stmt = db.prepare(
    `INSERT INTO seen_urls (url, source_id) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET seen_at = ${NOW}`,
  );
  for (const url of new Set(urls)) stmt.run(url, sourceId);
}

export function insertArticle(a: NewArticle): boolean {
  const r = db
    .prepare(
      `INSERT INTO articles (source_id, url, title, excerpt, image_path, image_url, author, published_at, categories)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO NOTHING`,
    )
    .run(a.source_id, a.url, a.title, a.excerpt, a.image_path, a.image_url, a.author, a.published_at, a.categories);
  return r.changes > 0;
}

export interface ArticleFilter {
  source?: number;
  q?: string;
  /** ISO timestamp; only articles published (or, lacking a date, fetched) at or after it. */
  since?: string;
  /** Leave out articles you've opened. */
  unread?: boolean;
  /** Only saved articles. */
  saved?: boolean;
}

export interface ArticleQuery extends ArticleFilter {
  sort?: "newest" | "oldest";
  limit: number;
  /** Keyset cursor: continue after the row with this sort key and id. An offset would skip a row
   *  for every article hidden since the previous page, since hidden rows leave the result set. */
  after?: { key: string; id: number };
}

const SORT_KEY = `coalesce(a.published_at, a.fetched_at)`;

/** Parses the "<sort key>|<id>" cursor that listArticles returns as `next`. */
export function parseKeyset(s: string): ArticleQuery["after"] {
  const m = /^(.+)\|(\d+)$/.exec(s);
  return m ? { key: m[1], id: Number(m[2]) } : undefined;
}

/**
 * Further reports of a story stay out of the main list and ride along on the first report as
 * `coverage`. Not with a source filter, though: there the lead may belong to another source, and
 * collapsing would hide that source's own article.
 */
export const collapses = (f: ArticleFilter) => !f.source && !f.saved;

/** Hidden articles are left out of every view. */
function articleFilter(f: ArticleFilter, { leadsOnly = false } = {}) {
  const where = [`coalesce(f.hidden, 0) = 0`];
  const params: (string | number)[] = [];
  if (f.source) {
    where.push(`a.source_id = ?`);
    params.push(f.source);
  }
  if (f.q) {
    // Escape LIKE's wildcards so a search for "100%" or "file_name" matches literally.
    const pattern = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(`(a.title LIKE ? ESCAPE '\\' OR a.excerpt LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }
  // Both columns hold toISOString() output, so string order is time order.
  if (f.since) {
    where.push(`${SORT_KEY} >= ?`);
    params.push(f.since);
  }
  if (f.unread) where.push(`coalesce(f.clicks, 0) = 0`);
  if (f.saved) where.push(`f.saved = 1`);
  if (leadsOnly && collapses(f)) where.push(`a.dup_of IS NULL`);
  return { clause: `WHERE ${where.join(" AND ")}`, params };
}

// The embedding stays server-side; the UI gets the reaction state instead.
const ARTICLE_COLUMNS = `a.id, a.source_id, a.url, a.title, a.excerpt, a.image_path, a.image_url, a.author,
  a.published_at, a.categories, a.fetched_at, coalesce(s.title, s.url) AS source_title,
  coalesce(f.rating, 0) AS rating, coalesce(f.clicks, 0) AS clicks, coalesce(f.saved, 0) AS saved, f.saved_at`;
const ARTICLE_JOINS = `FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN feedback f ON f.url = a.url`;

export type ArticleRow = Article & {
  source_title: string;
  rating: number;
  clicks: number;
  saved: number;
  saved_at: string | null;
};

export interface Coverage {
  id: number;
  url: string;
  title: string;
  source_title: string;
}

/** Adds `coverage`, the other visible reports of each row's story, when the filter collapses them. */
export function withCoverage<T extends { id: number }>(rows: T[], f: ArticleFilter): (T & { coverage: Coverage[] })[] {
  if (!collapses(f) || !rows.length) return rows.map((r) => ({ ...r, coverage: [] }));
  const byLead = new Map<number, Coverage[]>();
  const dups = db
    .prepare(
      `SELECT a.id, a.url, a.title, a.dup_of, coalesce(s.title, s.url) AS source_title ${ARTICLE_JOINS}
       WHERE a.dup_of IN (${rows.map(() => "?").join(",")}) AND coalesce(f.hidden, 0) = 0
       ORDER BY ${SORT_KEY}`,
    )
    .all(...rows.map((r) => r.id)) as unknown as (Coverage & { dup_of: number })[];
  for (const { dup_of, ...d } of dups) byLead.set(dup_of, [...(byLead.get(dup_of) ?? []), d]);
  return rows.map((r) => ({ ...r, coverage: byLead.get(r.id) ?? [] }));
}

/** Latest and Saved views. Saved sorts by when you saved, the others by publish date. */
export function listArticles(query: ArticleQuery) {
  const { sort, limit, after } = query;
  const { clause, params } = articleFilter(query, { leadsOnly: true });
  const key = query.saved ? `f.saved_at` : SORT_KEY;
  const total = (db.prepare(`SELECT count(*) AS n ${ARTICLE_JOINS} ${clause}`).get(...params) as { n: number }).n;
  const [dir, cmp] = sort === "oldest" ? ["ASC", ">"] : ["DESC", "<"];
  const page = after ? ` AND (${key} ${cmp} ? OR (${key} = ? AND a.id ${cmp} ?))` : "";
  const rows = db
    .prepare(
      `SELECT ${ARTICLE_COLUMNS}, ${key} AS sort_key ${ARTICLE_JOINS} ${clause}${page}
       ORDER BY ${key} ${dir}, a.id ${dir}
       LIMIT ?`,
    )
    .all(...params, ...(after ? [after.key, after.key, after.id] : []), limit) as unknown as (ArticleRow & { sort_key: string })[];
  const last = rows.at(-1);
  const next = rows.length === limit && last ? `${last.sort_key}|${last.id}` : null;
  return { total, rows: withCoverage(rows.map(({ sort_key: _k, ...r }) => r), query), next };
}

export type RankableRow = ArticleRow & { dup_of: number | null; embedding: Float32Array | null };

/** Every visible article matching the filters, with its embedding, for ranking and search. */
export function candidateArticles(filter: ArticleFilter, opts: { leadsOnly?: boolean } = {}): RankableRow[] {
  const { clause, params } = articleFilter(filter, opts);
  return (
    db
      .prepare(`SELECT ${ARTICLE_COLUMNS}, a.dup_of, a.embedding ${ARTICLE_JOINS} ${clause}`)
      .all(...params) as (Omit<RankableRow, "embedding"> & { embedding: Uint8Array | null })[]
  ).map((r) => ({ ...r, embedding: fromBlob(r.embedding) }));
}

/** One article by id, hidden or not, with its story's other reports. */
export function getArticle(id: number) {
  const row = db
    .prepare(`SELECT ${ARTICLE_COLUMNS}, coalesce(f.hidden, 0) AS hidden, a.dup_of ${ARTICLE_JOINS} WHERE a.id = ?`)
    .get(id) as unknown as (ArticleRow & { hidden: number; dup_of: number | null }) | undefined;
  if (!row) return undefined;
  // Coverage hangs off the story's lead: the first report, which a later report points at.
  const leadId = row.dup_of ?? row.id;
  const [story] = withCoverage([{ id: leadId }], {});
  const lead = row.dup_of
    ? (db.prepare(`SELECT a.id, a.url, a.title, coalesce(s.title, s.url) AS source_title ${ARTICLE_JOINS} WHERE a.id = ?`)
        .get(leadId) as unknown as Coverage | undefined)
    : undefined;
  const coverage = [...(lead ? [lead] : []), ...story.coverage].filter((c) => c.id !== row.id);
  return { ...row, coverage };
}

/** Visible articles by id, for turning matches on a story's other reports into its lead. */
export function articlesById(ids: number[]): ArticleRow[] {
  if (!ids.length) return [];
  return db
    .prepare(`SELECT ${ARTICLE_COLUMNS} ${ARTICLE_JOINS} WHERE a.id IN (${ids.map(() => "?").join(",")}) AND coalesce(f.hidden, 0) = 0`)
    .all(...ids) as unknown as ArticleRow[];
}

// ─── Story clusters ─────────────────────────────────────────────────────────

export interface ClusterInput {
  id: number;
  url: string;
  title: string;
  date: string;
  dup_of: number | null;
  clustered: number;
  embedding: Float32Array;
}

/** Whether any embedded article still waits for clustering. Reads no vectors. */
export function hasUnclustered(): boolean {
  return !!db.prepare(`SELECT 1 FROM articles WHERE clustered = 0 AND embedding IS NOT NULL LIMIT 1`).get();
}

/** Every embedded article, oldest first, so earlier arrivals become the leads. */
export function clusterInputs(): ClusterInput[] {
  return (
    db
      .prepare(
        `SELECT id, url, title, ${SORT_KEY.replaceAll("a.", "")} AS date, dup_of, clustered, embedding
         FROM articles WHERE embedding IS NOT NULL ORDER BY id`,
      )
      .all() as (Omit<ClusterInput, "embedding"> & { embedding: Uint8Array })[]
  ).map((r) => ({ ...r, embedding: fromBlob(r.embedding)! }));
}

export function setCluster(id: number, dupOf: number | null): void {
  db.prepare(`UPDATE articles SET dup_of = ?, clustered = 1 WHERE id = ?`).run(dupOf, id);
}

// ─── Embeddings ─────────────────────────────────────────────────────────────

export interface EmbedJob {
  table: "articles" | "feedback";
  key: string | number;
  title: string;
  excerpt: string | null;
  categories: string | null;
}

/** Articles and feedback rows that still need an embedding. */
export function pendingEmbeddings(limit: number): EmbedJob[] {
  return db
    .prepare(
      `SELECT 'articles' AS "table", id AS key, title, excerpt, categories FROM articles WHERE embedding IS NULL
       UNION ALL
       SELECT 'feedback', url, title, excerpt, categories FROM feedback WHERE embedding IS NULL
       LIMIT ?`,
    )
    .all(limit) as unknown as EmbedJob[];
}

export function saveEmbedding(job: EmbedJob, v: Float32Array): void {
  const keyColumn = job.table === "articles" ? "id" : "url";
  db.prepare(`UPDATE ${job.table} SET embedding = ? WHERE ${keyColumn} = ?`).run(toBlob(v), job.key);
}

// ─── Feedback ───────────────────────────────────────────────────────────────

export interface FeedbackChange {
  rating?: -1 | 0 | 1;
  hidden?: boolean;
  click?: boolean;
  saved?: boolean;
}

/** Records a reaction to a stored article, snapshotting its text and embedding on first touch. */
export function recordFeedback(articleId: number, change: FeedbackChange): boolean {
  const a = db
    .prepare(`SELECT url, source_id, title, excerpt, categories, embedding FROM articles WHERE id = ?`)
    .get(articleId) as
    | { url: string; source_id: number; title: string; excerpt: string | null; categories: string | null; embedding: Uint8Array | null }
    | undefined;
  if (!a) return false;
  db.prepare(
    `INSERT INTO feedback (url, source_id, title, excerpt, categories, embedding)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO NOTHING`,
  ).run(a.url, a.source_id, a.title, a.excerpt, a.categories, a.embedding);
  updateFeedback(a.url, change, a.embedding);
  return true;
}

function updateFeedback(url: string, change: FeedbackChange, embedding: Uint8Array | null = null): void {
  const saved = change.saved === undefined ? null : Number(change.saved);
  db.prepare(
    `UPDATE feedback SET
       rating     = coalesce(?, rating),
       hidden     = coalesce(?, hidden),
       clicks     = clicks + ?,
       saved_at   = CASE WHEN ? = 1 AND saved = 0 THEN ${NOW} WHEN ? = 0 THEN NULL ELSE saved_at END,
       saved      = coalesce(?, saved),
       embedding  = coalesce(embedding, ?),
       updated_at = ${NOW}
     WHERE url = ?`,
  ).run(
    change.rating ?? null,
    change.hidden === undefined ? null : Number(change.hidden),
    change.click ? 1 : 0,
    saved,
    saved,
    saved,
    embedding,
    url,
  );
}

export function listFeedback(): Feedback[] {
  return (
    db
      .prepare(`SELECT url, rating, hidden, clicks, saved, source_id, title, categories, embedding FROM feedback`)
      .all() as (Omit<Feedback, "embedding"> & { embedding: Uint8Array | null })[]
  ).map((f) => ({ ...f, embedding: fromBlob(f.embedding) }));
}

export interface Reaction {
  url: string;
  title: string;
  rating: number;
  hidden: number;
  clicks: number;
  saved: number;
  updated_at: string;
  source_title: string | null;
  /** Null once the article itself has been pruned; the reaction lives on. */
  article_id: number | null;
}

/** Thumbs and hides, newest first, for the profile page. Opens and saves alone aren't listed. */
export function listReactions(): Reaction[] {
  return db
    .prepare(
      `SELECT f.url, f.title, f.rating, f.hidden, f.clicks, f.saved, f.updated_at,
              coalesce(s.title, s.url) AS source_title, a.id AS article_id
       FROM feedback f LEFT JOIN sources s ON s.id = f.source_id LEFT JOIN articles a ON a.url = f.url
       WHERE f.rating != 0 OR f.hidden = 1
       ORDER BY f.updated_at DESC`,
    )
    .all() as unknown as Reaction[];
}

/** Changes a reaction by URL, which works after the article is pruned too. */
export function changeReaction(url: string, change: Pick<FeedbackChange, "rating" | "hidden">): boolean {
  if (!db.prepare(`SELECT 1 FROM feedback WHERE url = ?`).get(url)) return false;
  updateFeedback(url, change);
  return true;
}

/** Forgets every thumb, hide and open. Saved articles stay saved. */
export function resetProfile(): void {
  db.exec(`DELETE FROM feedback WHERE saved = 0; UPDATE feedback SET rating = 0, hidden = 0, clicks = 0`);
}

function imagePathsWhere(where: string, ...params: (string | number)[]): string[] {
  return (
    db
      .prepare(`SELECT image_path FROM articles WHERE image_path IS NOT NULL AND ${where}`)
      .all(...params) as { image_path: string }[]
  ).map((r) => r.image_path);
}

/** Deletes articles older than the cutoff and returns their image files for removal. Saved articles stay. */
export function pruneArticles(retentionDays: number): string[] {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  // By fetch time, not publish time: pruning by publish date would delete a just-fetched
  // old post, and the next crawl would fetch it again.
  const where = `fetched_at < ? AND url NOT IN (SELECT url FROM feedback WHERE saved = 1)`;
  const images = imagePathsWhere(where, cutoff);
  db.prepare(`DELETE FROM articles WHERE ${where}`).run(cutoff);
  // A kept article was fetched after the cutoff, so its own URLs were seen after it too.
  db.prepare(`DELETE FROM seen_urls WHERE seen_at < ?`).run(cutoff);
  return images;
}
