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
  source_id: number | null;
  title: string;
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

// Columns added after the first release.
const articleColumns = new Set(
  (db.prepare(`PRAGMA table_info(articles)`).all() as { name: string }[]).map((c) => c.name),
);
if (!articleColumns.has("categories")) db.exec(`ALTER TABLE articles ADD COLUMN categories TEXT`);
if (!articleColumns.has("embedding")) db.exec(`ALTER TABLE articles ADD COLUMN embedding BLOB`);

const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
// Copy, since a BLOB's byteOffset isn't guaranteed to be 4-byte aligned.
const fromBlob = (b: Uint8Array | null) => (b ? new Float32Array(b.slice().buffer) : null);

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

export function deleteSource(id: number): string[] {
  const images = imagePathsWhere(`source_id = ?`, id);
  db.prepare(`DELETE FROM sources WHERE id = ?`).run(id);
  return images;
}

// ─── Articles ───────────────────────────────────────────────────────────────

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

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

export interface ArticleQuery {
  source?: number;
  q?: string;
  /** ISO timestamp; only articles published (or, lacking a date, fetched) at or after it. */
  since?: string;
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

type ArticleFilter = Pick<ArticleQuery, "source" | "q" | "since">;

/** Hidden articles are left out of every view. */
function articleFilter({ source, q, since }: ArticleFilter) {
  const where = [`coalesce(f.hidden, 0) = 0`];
  const params: (string | number)[] = [];
  if (source) {
    where.push(`a.source_id = ?`);
    params.push(source);
  }
  if (q) {
    // Escape LIKE's wildcards so a search for "100%" or "file_name" matches literally.
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(`(a.title LIKE ? ESCAPE '\\' OR a.excerpt LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }
  // Both columns hold toISOString() output, so string order is time order.
  if (since) {
    where.push(`coalesce(a.published_at, a.fetched_at) >= ?`);
    params.push(since);
  }
  return { clause: `WHERE ${where.join(" AND ")}`, params };
}

// The embedding stays server-side; the UI gets the rating instead.
const ARTICLE_COLUMNS = `a.id, a.source_id, a.url, a.title, a.excerpt, a.image_path, a.image_url, a.author,
  a.published_at, a.categories, a.fetched_at, coalesce(s.title, s.url) AS source_title,
  coalesce(f.rating, 0) AS rating`;
const ARTICLE_JOINS = `FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN feedback f ON f.url = a.url`;

export function listArticles({ source, q, since, sort, limit, after }: ArticleQuery) {
  const { clause, params } = articleFilter({ source, q, since });
  const total = (db.prepare(`SELECT count(*) AS n ${ARTICLE_JOINS} ${clause}`).get(...params) as { n: number }).n;
  const [dir, cmp] = sort === "oldest" ? ["ASC", ">"] : ["DESC", "<"];
  const page = after ? ` AND (${SORT_KEY} ${cmp} ? OR (${SORT_KEY} = ? AND a.id ${cmp} ?))` : "";
  const rows = db
    .prepare(
      `SELECT ${ARTICLE_COLUMNS}, ${SORT_KEY} AS sort_key ${ARTICLE_JOINS} ${clause}${page}
       ORDER BY ${SORT_KEY} ${dir}, a.id ${dir}
       LIMIT ?`,
    )
    .all(...params, ...(after ? [after.key, after.key, after.id] : []), limit) as unknown as (Article & { sort_key: string })[];
  const last = rows.at(-1);
  const next = rows.length === limit && last ? `${last.sort_key}|${last.id}` : null;
  return { total, rows: rows.map(({ sort_key: _k, ...r }) => r), next };
}

export type ArticleRow = Article & {
  source_title: string;
  rating: number;
  clicks: number;
  embedding: Float32Array | null;
};

/** Every visible article matching the filters, with its embedding, for ranking. */
export function candidateArticles(filter: ArticleFilter): ArticleRow[] {
  const { clause, params } = articleFilter(filter);
  return (
    db
      .prepare(`SELECT ${ARTICLE_COLUMNS}, coalesce(f.clicks, 0) AS clicks, a.embedding ${ARTICLE_JOINS} ${clause}`)
      .all(...params) as (Omit<ArticleRow, "embedding"> & { embedding: Uint8Array | null })[]
  ).map((r) => ({ ...r, embedding: fromBlob(r.embedding) }));
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
  db.prepare(
    `UPDATE feedback SET
       rating     = coalesce(?, rating),
       hidden     = coalesce(?, hidden),
       clicks     = clicks + ?,
       embedding  = coalesce(embedding, ?),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE url = ?`,
  ).run(
    change.rating ?? null,
    change.hidden === undefined ? null : Number(change.hidden),
    change.click ? 1 : 0,
    a.embedding,
    a.url,
  );
  return true;
}

export function listFeedback(): Feedback[] {
  return (
    db
      .prepare(`SELECT url, rating, hidden, clicks, source_id, title, embedding FROM feedback`)
      .all() as (Omit<Feedback, "embedding"> & { embedding: Uint8Array | null })[]
  ).map((f) => ({ ...f, embedding: fromBlob(f.embedding) }));
}

function imagePathsWhere(where: string, ...params: (string | number)[]): string[] {
  return (
    db
      .prepare(`SELECT image_path FROM articles WHERE image_path IS NOT NULL AND ${where}`)
      .all(...params) as { image_path: string }[]
  ).map((r) => r.image_path);
}

/** Deletes articles older than the cutoff and returns their image files for removal. */
export function pruneArticles(retentionDays: number): string[] {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  // By fetch time, not publish time: pruning by publish date would delete a just-fetched
  // old post, and the next crawl would fetch it again.
  const where = `fetched_at < ?`;
  const images = imagePathsWhere(where, cutoff);
  db.prepare(`DELETE FROM articles WHERE ${where}`).run(cutoff);
  // A kept article was fetched after the cutoff, so its own URLs were seen after it too.
  db.prepare(`DELETE FROM seen_urls WHERE seen_at < ?`).run(cutoff);
  return images;
}
