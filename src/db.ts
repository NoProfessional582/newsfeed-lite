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

export function articleExists(url: string): boolean {
  return db.prepare(`SELECT 1 FROM articles WHERE url = ?`).get(url) !== undefined;
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
  offset: number;
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
    where.push(`(a.title LIKE ? OR a.excerpt LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`);
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

export function listArticles({ source, q, since, sort, limit, offset }: ArticleQuery) {
  const { clause, params } = articleFilter({ source, q, since });
  const total = (db.prepare(`SELECT count(*) AS n ${ARTICLE_JOINS} ${clause}`).get(...params) as { n: number }).n;
  const dir = sort === "oldest" ? "ASC" : "DESC";
  const rows = db
    .prepare(
      `SELECT ${ARTICLE_COLUMNS} ${ARTICLE_JOINS} ${clause}
       ORDER BY coalesce(a.published_at, a.fetched_at) ${dir}, a.id ${dir}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return { total, rows };
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
  return images;
}
