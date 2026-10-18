import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import robotsParserModule from "robots-parser";
import { config } from "./config.ts";

export const LIMITS = {
  pageBytes: 5_000_000,
  feedBytes: 10_000_000,
  imageBytes: 8_000_000,
  maxRedirects: 5,
};

export class FetchError extends Error {
  /** True for failures worth retrying as-is next run: 429, 5xx, timeouts, network errors. */
  temporary: boolean;
  constructor(message: string, temporary = false) {
    super(message);
    this.temporary = temporary;
  }
}

/**
 * The host is rate-limiting us or has used up its request budget for this run, so nothing
 * was sent. Callers should skip the work and retry next run, not treat the URL as missing.
 */
export class HostLimitError extends FetchError {
  constructor(message: string) {
    super(message, true);
  }
}

export interface FetchResult {
  url: string; // final URL after redirects
  status: number;
  contentType: string;
  body: Buffer;
  text(): string;
}

// ─── Global concurrency + per-host spacing ──────────────────────────────────

let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < config.concurrency) {
    active++;
    return;
  }
  await new Promise<void>((r) => waiting.push(r));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

const nextSlot = new Map<string, number>();

/** Reserve the next free slot for a host so requests to it are at least perHostDelayMs apart. */
async function hostTurn(host: string): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + config.perHostDelayMs);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

// ─── Per-host backoff and budget ────────────────────────────────────────────
// A 429 stops all requests to that host for the rest of the run, and for as long as its
// Retry-After asks if that is longer. The budget caps how hard one run can hit one host,
// which matters when several sources share a site.

const throttledThisRun = new Set<string>();
const blockedUntil = new Map<string, number>();
const requestsThisRun = new Map<string, number>();

/** Call at the start of each crawl run. Retry-After deadlines carry over; the rest resets. */
export function startRun(): void {
  throttledThisRun.clear();
  requestsThisRun.clear();
}

function checkHost(host: string): void {
  if (throttledThisRun.has(host)) throw new HostLimitError(`${host} is rate-limiting us; skipped until next run`);
  const until = blockedUntil.get(host) ?? 0;
  if (until > Date.now()) {
    throw new HostLimitError(`${host} asked us to wait until ${new Date(until).toISOString()} (Retry-After)`);
  }
  if ((requestsThisRun.get(host) ?? 0) >= config.maxRequestsPerHostPerRun) {
    throw new HostLimitError(`request budget for ${host} used up (${config.maxRequestsPerHostPerRun} per run)`);
  }
}

/** Retry-After is either delay-seconds or an HTTP date. Returns milliseconds, or 0. */
function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function noteBackoff(host: string, status: number, retryAfter: string | null): void {
  if (status !== 429 && status !== 503) return;
  const wait = retryAfterMs(retryAfter);
  if (wait) blockedUntil.set(host, Math.max(blockedUntil.get(host) ?? 0, Date.now() + wait));
  if (status === 429 && !throttledThisRun.has(host)) {
    throttledThisRun.add(host);
    console.warn(`[fetch] 429 from ${host}; skipping it for the rest of this run${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}`);
  }
}

// ─── Destination checks ─────────────────────────────────────────────────────
// Article and image URLs come from third-party feeds, so a hostile feed could point
// the crawler at the LAN (router admin pages, the Hyper-V VMs). Refuse private targets.

function isPrivate(ip: string): boolean {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^(fc|fd|fe[89ab])/.test(v6);
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError(`refusing ${url.protocol} URL`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivate)) throw new FetchError(`refusing private address for ${host}`);
}

// ─── robots.txt ─────────────────────────────────────────────────────────────

// robots-parser is CommonJS but its typings declare an ESM default export, which
// nodenext resolution then hides behind `.default`. At runtime the import is the function.
interface Robots {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
const robotsParser = robotsParserModule as unknown as (url: string, body: string) => Robots;

const robotsCache = new Map<string, Promise<Robots | null>>();

async function allowedByRobots(url: URL): Promise<boolean> {
  if (!config.respectRobots) return true;
  let entry = robotsCache.get(url.origin);
  if (!entry) {
    const robotsUrl = `${url.origin}/robots.txt`;
    entry = rawGet(robotsUrl, 500_000)
      .then((r) => (r.status < 400 ? robotsParser(robotsUrl, r.text()) : null))
      .catch(() => null);
    robotsCache.set(url.origin, entry);
  }
  const robots = await entry;
  return robots?.isAllowed(url.href, config.userAgent) ?? true;
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new FetchError(`response too large (${declared} bytes)`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new FetchError(`response exceeded ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

/** One GET with redirects followed by hand so every hop is checked. No robots check. */
async function rawGet(href: string, maxBytes: number, accept?: string): Promise<FetchResult> {
  let url = new URL(href);
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    await assertPublic(url);
    checkHost(url.host);
    // Wait for the host first, then take a slot: a request queued behind a slow host must
    // neither hold a slot other hosts could use nor burn its timeout while waiting.
    await hostTurn(url.host);
    checkHost(url.host); // the host may have started throttling while this request queued
    requestsThisRun.set(url.host, (requestsThisRun.get(url.host) ?? 0) + 1);
    await acquire();
    try {
      const result = await fetchOnce(url, maxBytes, accept).catch((e: unknown) => {
        if (e instanceof FetchError) throw e;
        // Timeouts, resets, DNS hiccups: transient, not a sign the URL is wrong.
        throw new FetchError(`${e instanceof Error ? e.message : String(e)} (${url.href})`, true);
      });
      if ("redirect" in result) {
        url = result.redirect;
        continue;
      }
      return result;
    } finally {
      release();
    }
  }
  throw new FetchError(`too many redirects for ${href}`);
}

async function fetchOnce(url: URL, maxBytes: number, accept?: string): Promise<FetchResult | { redirect: URL }> {
  const signal = AbortSignal.timeout(config.timeoutMs);
  const res = await fetch(url, {
    redirect: "manual",
    signal,
    headers: {
      "User-Agent": config.userAgent,
      Accept: accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
  });
  noteBackoff(url.host, res.status, res.headers.get("retry-after"));
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    await res.body?.cancel();
    return { redirect: new URL(location, url) };
  }
  const body = await readCapped(res, maxBytes);
  const finalUrl = url.href;
  return {
    url: finalUrl,
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body,
    text: () => decode(body, res.headers.get("content-type")),
  };
}

function decode(body: Buffer, contentType: string | null): string {
  const charset = /charset=([\w-]+)/i.exec(contentType ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/**
 * GET through the global queue, robots.txt and destination checks.
 * Throws FetchError for refusals and HTTP errors (status >= 400).
 */
export async function get(
  href: string,
  opts: { maxBytes?: number; accept?: string } = {},
): Promise<FetchResult> {
  const url = new URL(href);
  if (!(await allowedByRobots(url))) throw new FetchError(`disallowed by robots.txt: ${href}`);
  const res = await rawGet(href, opts.maxBytes ?? LIMITS.pageBytes, opts.accept);
  if (res.status >= 400) {
    throw new FetchError(`HTTP ${res.status} from ${href}`, res.status === 429 || res.status >= 500);
  }
  return res;
}

/**
 * Like get(), but returns null instead of throwing. For optional fetches (images, probes).
 * HostLimitError still propagates, so a throttled host isn't mistaken for a missing page.
 */
export async function tryGet(
  href: string,
  opts: { maxBytes?: number; accept?: string } = {},
): Promise<FetchResult | null> {
  try {
    return await get(href, opts);
  } catch (e) {
    if (e instanceof HostLimitError) throw e;
    return null;
  }
}
