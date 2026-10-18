import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import robotsParserModule from "robots-parser";
import { Agent, fetch, type Response } from "undici";
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
  header(name: string): string | null;
}

export interface GetOptions {
  maxBytes?: number;
  accept?: string;
  /** Extra request headers, e.g. If-None-Match for a conditional feed fetch. */
  headers?: Record<string, string>;
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
  if (nextSlot.size > 1000) pruneHostState(now); // between runs, e.g. many sources added at once
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
  pruneHostState();
}

// Feeds and articles name new hosts all the time (images, link shorteners), so the per-host maps
// drop entries that no longer say anything, and the robots.txt cache is capped.
const ROBOTS_MAX = 500;

/** Drops passed spacing slots and Retry-After deadlines, and expired robots.txt rules. */
export function pruneHostState(now = Date.now()): void {
  for (const [host, at] of nextSlot) if (at <= now) nextSlot.delete(host);
  for (const [host, until] of blockedUntil) if (until <= now) blockedUntil.delete(host);
  for (const [origin, entry] of robotsCache) if (entry.expires < now) robotsCache.delete(origin);
}

/** Entry counts of the per-host maps, for tests. */
export function hostStateSizes() {
  return { nextSlot: nextSlot.size, blockedUntil: blockedUntil.size, robots: robotsCache.size };
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

// BlockList also matches IPv4-mapped IPv6 (::ffff:7f00:1, as URL literals serialize) against the IPv4 rules.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, bits, "ipv6");

export function isPrivate(ip: string): boolean {
  const family = isIP(ip);
  return family === 0 || blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Refuses non-HTTP schemes and private IP literals. Hostnames are checked at connect time. */
function assertPublic(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError(`refusing ${url.protocol} URL`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivate(host)) throw new FetchError(`refusing private address ${host}`);
}

// Checking DNS before fetch() and letting fetch resolve again would leave a rebinding window, so
// the check runs inside the connection's own lookup: the address checked is the one connected to.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, "", 0);
    const list = addrs as LookupAddress[];
    if (!list.length || list.some((a) => isPrivate(a.address))) {
      return callback(new FetchError(`refusing private address for ${hostname}`), "", 0);
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

const dispatcher = new Agent({ connect: { lookup: publicLookup } });

// ─── robots.txt ─────────────────────────────────────────────────────────────

// robots-parser is CommonJS but its typings declare an ESM default export, which
// nodenext resolution then hides behind `.default`. At runtime the import is the function.
interface Robots {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
const robotsParser = robotsParserModule as unknown as (url: string, body: string) => Robots;

const ROBOTS_TTL_MS = 24 * 3_600_000;
const ROBOTS_RETRY_MS = 10 * 60_000;

/** A parsed file, null for "no rules" (missing file), or the error that kept us from reading it. */
type RobotsResult = Robots | null | FetchError;
const robotsCache = new Map<string, { expires: number; result: Promise<RobotsResult> }>();

// RFC 9309: a missing file (4xx) means no rules, but an unreachable one (5xx, 429, network error)
// means we can't know the rules, so the request waits for a later run instead of going ahead.
async function fetchRobots(origin: string): Promise<{ result: RobotsResult; ttl: number }> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const r = await rawGet(robotsUrl, 500_000);
    if (r.status === 429 || r.status >= 500) {
      return { result: new FetchError(`robots.txt unavailable (HTTP ${r.status}) for ${origin}`, true), ttl: ROBOTS_RETRY_MS };
    }
    return { result: r.status < 400 ? robotsParser(robotsUrl, r.text()) : null, ttl: ROBOTS_TTL_MS };
  } catch (e) {
    if (e instanceof FetchError && e.temporary) return { result: e, ttl: ROBOTS_RETRY_MS };
    return { result: null, ttl: ROBOTS_TTL_MS }; // e.g. an oversized file: treat as no rules
  }
}

async function allowedByRobots(url: URL): Promise<boolean> {
  if (!config.respectRobots) return true;
  let entry = robotsCache.get(url.origin);
  if (!entry || entry.expires < Date.now()) {
    const pending = fetchRobots(url.origin);
    const created: { expires: number; result: Promise<RobotsResult> } = {
      expires: Infinity, // until the fetch settles and sets the real expiry
      result: pending.then((p) => p.result),
    };
    void pending.then((p) => (created.expires = Date.now() + p.ttl));
    // Re-inserted last, so the cap drops the origins fetched longest ago first.
    robotsCache.delete(url.origin);
    while (robotsCache.size >= ROBOTS_MAX) robotsCache.delete(robotsCache.keys().next().value!);
    robotsCache.set(url.origin, (entry = created));
  }
  const robots = await entry.result;
  if (robots instanceof FetchError) throw robots;
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
async function rawGet(href: string, maxBytes: number, opts: GetOptions = {}): Promise<FetchResult> {
  let url = new URL(href);
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    assertPublic(url);
    checkHost(url.host);
    // Wait for the host first, then take a slot: a request queued behind a slow host must
    // neither hold a slot other hosts could use nor burn its timeout while waiting.
    await hostTurn(url.host);
    checkHost(url.host); // the host may have started throttling while this request queued
    requestsThisRun.set(url.host, (requestsThisRun.get(url.host) ?? 0) + 1);
    await acquire();
    try {
      const result = await fetchOnce(url, maxBytes, opts).catch((e: unknown) => {
        if (e instanceof FetchError) throw e;
        // fetch() wraps errors from the connection, including publicLookup's refusal, in a TypeError.
        if (e instanceof Error && e.cause instanceof FetchError) throw e.cause;
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

async function fetchOnce(url: URL, maxBytes: number, opts: GetOptions): Promise<FetchResult | { redirect: URL }> {
  const signal = AbortSignal.timeout(config.timeoutMs);
  const res = await fetch(url, {
    redirect: "manual",
    signal,
    dispatcher,
    headers: {
      "User-Agent": config.userAgent,
      Accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      ...opts.headers,
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
    header: (name) => res.headers.get(name),
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
  opts: GetOptions = {},
): Promise<FetchResult> {
  const url = new URL(href);
  if (!(await allowedByRobots(url))) throw new FetchError(`disallowed by robots.txt: ${href}`);
  const res = await rawGet(href, opts.maxBytes ?? LIMITS.pageBytes, opts);
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
  opts: GetOptions = {},
): Promise<FetchResult | null> {
  try {
    return await get(href, opts);
  } catch (e) {
    if (e instanceof HostLimitError) throw e;
    return null;
  }
}
