// Headless single run, e.g. for a Windows scheduled task: `npm run crawl`.
import { crawlAll } from "./crawler.ts";

await crawlAll();
