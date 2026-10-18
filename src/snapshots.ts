import { randomUUID } from "node:crypto";

// Ranked views (For you, search) score every candidate at once. Ranking again for every page would
// let the order shift under the reader (a hide or 👍 on page one re-ranks the rest), skipping or
// repeating articles. So the first page ranks once and stores the order, and later pages slice that
// snapshot. The cursor is "<snapshot id>:<offset>".

const TTL_MS = 30 * 60_000;
const MAX = 8;

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
  while (snapshots.size >= MAX) snapshots.delete(snapshots.keys().next().value!);
  const id = randomUUID().slice(0, 8);
  const s: Snapshot<T, M> = { rows, meta, created: now };
  snapshots.set(id, s as Snapshot<unknown, unknown>);
  return slice(id, s, 0, limit);
}

/** The page a cursor points at, or null if it isn't a snapshot cursor or the snapshot expired. */
export function nextPage<T, M>(after: string | undefined, limit: number): Page<T, M> | null {
  const m = after ? /^([0-9a-f]{8}):(\d+)$/.exec(after) : null;
  const s = m ? (snapshots.get(m[1]) as Snapshot<T, M> | undefined) : undefined;
  if (!m || !s || Date.now() - s.created >= TTL_MS) return null;
  return slice(m[1], s, Number(m[2]), limit);
}
