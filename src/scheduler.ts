import { config } from "./config.ts";
import { crawlAll } from "./crawler.ts";

/** Crawl once at startup, then every intervalMinutes. crawlAll() itself skips overlapping runs. */
export function startScheduler(): void {
  const run = () => crawlAll().catch((e) => console.error("[crawl] failed:", e));
  setTimeout(run, 2_000);
  if (config.intervalMinutes > 0) setInterval(run, config.intervalMinutes * 60_000);
}
