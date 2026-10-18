import { randomUUID } from "node:crypto";

// Ranked views (For you, search) score every candidate at once. Ranking again for every page would
// let the order shift under the reader (a hide or 👍 on page one re-ranks the rest), skipping or
// repeating articles. So the first page ranks once and stores the order, and later pages slice that
// snapshot. The cursor is "<snapshot id>:<offset>".
//
// The UI and agents share the cache, and search typing in the UI makes a snapshot per keystroke,
// so a snapshot that is being paged through moves to the back of the line and its TTL restarts.
// A cursor whose snapshot is gone anyway is an error, never a silent restart at page one.

const TTL_MS = 30 * 60_000;
export const MAX_SNAPSHOTS = 24;

export class CursorExpiredError extends Error {
  constructor() {
    super("This cursor has expired (ranked results are kept for 30 minutes). Start again without a cursor.");
  }
}

interface Snapshot<T, M> {
  rows: T[];
  meta: M;
  created: number;
}

const snapshots = new Map<string, Snapshot<unknown, unknown>>();

export interface Page<T, M> {
  rows: T[];
  total: number;
  next: string | null;
  meta: M;
}

function slice<T, M>(id: string, s: Snapshot<T, M>, offset: number, limit: number): Page<T, M> {
  const end = offset + limit;
  return { rows: s.rows.slice(offset, end), total: s.rows.length, next: end < s.rows.length ? `${id}:${end}` : null, meta: s.meta };
}

/** Stores a ranking and returns its first page. */
export function firstPage<T, M>(rows: T[], meta: M, limit: number): Page<T, M> {
  const now = Date.now();
  for (const [id, s] of snapshots) if (now - s.created >= TTL_MS) snapshots.delete(id);
  while (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
  const id = randomUUID().slice(0, 8);
  const s: Snapshot<T, M> = { rows, meta, created: now };
  snapshots.set(id, s as Snapshot<unknown, unknown>);
  return slice(id, s, 0, limit);
}

/**
 * The page a cursor points at, or null if it isn't a snapshot cursor (it's another view's keyset).
 * Throws CursorExpiredError if its snapshot expired or was evicted.
 */
export function nextPage<T, M>(after: string | undefined, limit: number): Page<T, M> | null {
  const m = after ? /^([0-9a-f]{8}):(\d+)$/.exec(after) : null;
  if (!m) return null;
  const s = snapshots.get(m[1]) as Snapshot<T, M> | undefined;
  snapshots.delete(m[1]);
  const now = Date.now();
  if (!s || now - s.created >= TTL_MS) throw new CursorExpiredError();
  // Re-inserted last with a fresh TTL, so eviction takes the snapshots nobody is reading first.
  s.created = now;
  snapshots.set(m[1], s as Snapshot<unknown, unknown>);
  return slice(m[1], s, Number(m[2]), limit);
}
