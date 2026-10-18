// Query-string numbers for GET /api/articles. SQLite reads a negative LIMIT as "no limit" and a huge
// day count overflows Date, so values outside these ranges are refused or clamped here.

export const DEFAULT_LIMIT = 60;
export const MAX_LIMIT = 200;
export const MAX_DAYS = 3650; // ten years: older than anything retention keeps

export class ParamError extends Error {}

/** `limit`: missing means the default; a whole number from 1 up, capped at MAX_LIMIT. */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ParamError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  return Math.min(n, MAX_LIMIT);
}

/** `days`: a rolling window ending now, as an ISO cutoff. Missing, 0 or negative means no date limit. */
export function parseSince(raw: string | undefined, now = Date.now()): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const days = Number(raw);
  if (!Number.isFinite(days)) throw new ParamError("days must be a number");
  return days > 0 ? new Date(now - Math.min(days, MAX_DAYS) * 86_400_000).toISOString() : undefined;
}
