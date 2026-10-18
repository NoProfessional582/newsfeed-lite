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
  fetched_at: string;
}

export type NewArticle = Omit<Article, "id" | "fetched_at">;

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
`);

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
      `INSERT INTO articles (source_id, url, title, excerpt, image_path, image_url, author, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO NOTHING`,
    )
    .run(a.source_id, a.url, a.title, a.excerpt, a.image_path, a.image_url, a.author, a.published_at);
  return r.changes > 0;
}

export interface ArticleQuery {
  source?: number;
  q?: string;
  limit: number;
  offset: number;
}

export function listArticles({ source, q, limit, offset }: ArticleQuery) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (source) {
    where.push(`a.source_id = ?`);
    params.push(source);
  }
  if (q) {
    where.push(`(a.title LIKE ? OR a.excerpt LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT count(*) AS n FROM articles a ${clause}`).get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT a.*, coalesce(s.title, s.url) AS source_title
       FROM articles a JOIN sources s ON s.id = a.source_id
       ${clause}
       ORDER BY coalesce(a.published_at, a.fetched_at) DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return { total, rows };
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
