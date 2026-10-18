import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { relative } from "node:path";
import { config, ROOT, IMAGE_DIR } from "./config.ts";
import * as store from "./db.ts";
import { crawlAll, discoverSource, status } from "./crawler.ts";
import { deleteImages } from "./images.ts";
import { startScheduler } from "./scheduler.ts";
import { embedPending } from "./embed.ts";
import { forYou } from "./recommend.ts";

const app = new Hono();

app.get("/api/articles", (c) => {
  const source = Number(c.req.query("source")) || undefined;
  const q = c.req.query("q")?.trim() || undefined;
  const limit = Math.min(Number(c.req.query("limit")) || 60, 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const query = { source, q, limit, offset };
  return c.json(c.req.query("view") === "foryou" ? forYou(query) : store.listArticles(query));
});

app.post("/api/articles/:id/feedback", async (c) => {
  type Body = { rating?: unknown; hidden?: unknown; click?: unknown };
  const body = await c.req.json<Body>().catch((): Body => ({}));
  const change: store.FeedbackChange = {};
  if (body.rating === -1 || body.rating === 0 || body.rating === 1) change.rating = body.rating;
  if (typeof body.hidden === "boolean") change.hidden = body.hidden;
  if (body.click === true) change.click = true;
  if (!Object.keys(change).length) return c.json({ error: "Nothing to record" }, 400);
  if (!store.recordFeedback(Number(c.req.param("id")), change)) return c.json({ error: "No such article" }, 404);
  // A reaction to an article the model hasn't reached yet gets its vector in the background.
  void embedPending().catch((e) => console.error("[embed] failed:", e));
  return c.body(null, 204);
});

app.get("/api/sources", (c) => c.json(store.listSources()));

app.post("/api/sources", async (c) => {
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }));
  let parsed: URL;
  try {
    parsed = new URL(String(url ?? "").trim());
    if (!/^https?:$/.test(parsed.protocol)) throw new Error();
  } catch {
    return c.json({ error: "Enter a full http(s) URL" }, 400);
  }
  const source = store.insertSource(parsed.href);
  try {
    return c.json(await discoverSource(source), 201);
  } catch (e) {
    store.updateSource(source.id, { last_error: e instanceof Error ? e.message : String(e) });
    return c.json(store.getSource(source.id), 201);
  }
});

app.patch("/api/sources/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ enabled?: boolean; title?: string }>();
  const fields: Partial<store.Source> = {};
  if (typeof body.enabled === "boolean") fields.enabled = body.enabled ? 1 : 0;
  if (typeof body.title === "string") fields.title = body.title.trim() || null;
  store.updateSource(id, fields);
  return c.json(store.getSource(id) ?? null);
});

app.delete("/api/sources/:id", async (c) => {
  await deleteImages(store.deleteSource(Number(c.req.param("id"))));
  return c.body(null, 204);
});

app.post("/api/crawl", (c) => {
  const started = !status.running;
  if (started) void crawlAll().catch((e) => console.error("[crawl] failed:", e));
  return c.json({ started, status }, started ? 202 : 409);
});

app.get("/api/status", (c) => c.json({ ...status, intervalMinutes: config.intervalMinutes }));

const imageRoot = relative(process.cwd(), IMAGE_DIR) || ".";
app.use(
  "/images/*",
  serveStatic({
    root: imageRoot,
    rewriteRequestPath: (p) => p.replace(/^\/images/, ""),
    onFound: (_p, c) => c.header("Cache-Control", "public, max-age=604800, immutable"),
  }),
);
app.use(
  "/*",
  serveStatic({
    root: relative(process.cwd(), `${ROOT}/public`) || ".",
    // Revalidate the UI on every load so edits show up without a hard refresh.
    onFound: (_p, c) => c.header("Cache-Control", "no-cache"),
  }),
);

serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, ({ port }) => {
  console.log(`newsfeed-lite on http://localhost:${port}`);
});

startScheduler();
// Backfill vectors for articles stored before embeddings existed, or while the model was failing.
void embedPending().catch((e) => console.error("[embed] failed:", e));
