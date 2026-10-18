import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { IMAGE_DIR } from "./config.ts";
import { tryGet, LIMITS } from "./fetcher.ts";

const WIDTH = 640;
const HEIGHT = 400;
const MAX_PIXELS = 40_000_000; // refuse decompression bombs before decoding

/**
 * Downloads an article image and stores a 640x400 WebP crop. sharp's "attention"
 * strategy picks the busiest region, standing in for the old crawler's smart centering.
 * Returns the stored file name, or null if anything fails.
 */
export async function saveThumbnail(imageUrl: string, articleUrl: string): Promise<string | null> {
  const name = `${createHash("sha1").update(articleUrl).digest("hex")}.webp`;
  const dest = join(IMAGE_DIR, name);
  if (existsSync(dest)) return name;

  // A throttled image host just means no thumbnail; the article keeps the original image URL.
  const res = await tryGet(imageUrl, { maxBytes: LIMITS.imageBytes, accept: "image/avif,image/webp,image/*,*/*;q=0.5" })
    .catch(() => null);
  if (!res || !res.body.length) return null;
  try {
    const { width = 0, height = 0 } = await sharp(res.body, { limitInputPixels: MAX_PIXELS }).metadata();
    if (width < 200 || height < 100) return null; // logos, icons, tracking pixels
    await sharp(res.body, { limitInputPixels: MAX_PIXELS, animated: false })
      .rotate()
      .resize(WIDTH, HEIGHT, { fit: "cover", position: sharp.strategy.attention, withoutEnlargement: false })
      .webp({ quality: 75 })
      .toFile(dest);
    return name;
  } catch {
    return null;
  }
}

export async function deleteImages(names: string[]): Promise<void> {
  await Promise.all(names.map((n) => unlink(join(IMAGE_DIR, n)).catch(() => {})));
}
