import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const DATA_DIR = join(ROOT, "data");
export const IMAGE_DIR = join(DATA_DIR, "images");
mkdirSync(IMAGE_DIR, { recursive: true });

export interface Config {
  port: number;
  intervalMinutes: number;
  maxArticlesPerSource: number;
  retentionDays: number;
  concurrency: number;
  perHostDelayMs: number;
  maxRequestsPerHostPerRun: number;
  timeoutMs: number;
  respectRobots: boolean;
  userAgent: string;
}

const defaults: Config = {
  port: 4600,
  intervalMinutes: 60,
  maxArticlesPerSource: 20,
  retentionDays: 30,
  concurrency: 4,
  perHostDelayMs: 1000,
  maxRequestsPerHostPerRun: 100,
  timeoutMs: 15000,
  respectRobots: true,
  userAgent: "Mozilla/5.0 (compatible; newsfeed-lite/0.1; personal local reader)",
};

function load(): Config {
  try {
    return { ...defaults, ...JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8")) };
  } catch {
    return defaults;
  }
}

export const config = load();
