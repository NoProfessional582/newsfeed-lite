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

export class FetchError extends Error {}

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
    // Wait for the host first, then take a slot: a request queued behind a slow host must
    // neither hold a slot other hosts could use nor burn its timeout while waiting.
    await hostTurn(url.host);
    await acquire();
    try {
      const result = await fetchOnce(url, maxBytes, accept);
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
  if (res.status >= 400) throw new FetchError(`HTTP ${res.status} from ${href}`);
  return res;
}

/** Like get(), but returns null instead of throwing. For optional fetches (images, probes). */
export async function tryGet(
  href: string,
  opts: { maxBytes?: number; accept?: string } = {},
): Promise<FetchResult | null> {
  try {
    return await get(href, opts);
  } catch {
    return null;
  }
}
