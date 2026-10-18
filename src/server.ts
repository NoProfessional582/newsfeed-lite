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
import { forYou, profile } from "./recommend.ts";
import { search } from "./search.ts";
import { CursorExpiredError } from "./snapshots.ts";

const app = new Hono();

// Listening on 127.0.0.1 keeps the LAN out, but not other sites open in your browser.
// - Host: a DNS-rebinding page reaches us under its own hostname, so only loopback names pass.
// - Origin: a cross-site form or no-cors fetch carries the other site's origin.
// - Content-Type: requiring JSON forces a CORS preflight, which we never answer, on any cross-site write.
const allowedHosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]);
app.use("*", async (c, next) => {
  if (!allowedHosts.has(c.req.header("host") ?? "")) return c.text("Forbidden host", 403);
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) return c.json({ error: "Cross-origin request refused" }, 403);
    const hasBody = c.req.method === "POST" || c.req.method === "PATCH";
    if (hasBody && !/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
      return c.json({ error: "Expected application/json" }, 415);
    }
  }
  await next();
  // The UI renders text and links taken from other sites' feeds. Scripts come only from our own
  // files, so a hostile javascript: link or injected handler can't run even if one slips through.
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https: http:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
});

app.get("/api/articles", async (c) => {
  const source = Number(c.req.query("source")) || undefined;
  const q = c.req.query("q")?.trim() || undefined;
  const limit = Math.min(Number(c.req.query("limit")) || 60, 200);
  // `after` is the `next` cursor from the previous page; its shape depends on the view.
  const after = c.req.query("after") || undefined;
  // `days` is a rolling window ending now; anything missing or non-positive means no date limit.
  const days = Number(c.req.query("days"));
  const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
  const sort = c.req.query("sort") === "oldest" ? ("oldest" as const) : ("newest" as const);
  const view = c.req.query("view");
  const filter = { source, since, limit, unread: c.req.query("unread") === "1", saved: view === "saved" };
  try {
    // A search ranks by relevance in every view; Saved only narrows it to saved articles.
    if (q) return c.json(await search({ ...filter, q, after }));
    if (view === "foryou") return c.json(forYou({ ...filter, after }));
    return c.json(store.listArticles({ ...filter, sort, after: after ? store.parseKeyset(after) : undefined }));
  } catch (e) {
    // The ranking a ranked view's cursor pointed into is gone; the caller starts again from page one.
    if (e instanceof CursorExpiredError) return c.json({ error: e.message, code: "cursor_expired" }, 410);
    throw e;
  }
});

app.get("/api/articles/:id", (c) => {
  const a = store.getArticle(Number(c.req.param("id")));
  return a ? c.json(a) : c.json({ error: "No such article" }, 404);
});

app.post("/api/articles/:id/feedback", async (c) => {
  type Body = { rating?: unknown; hidden?: unknown; click?: unknown; saved?: unknown };
  const body = await c.req.json<Body>().catch((): Body => ({}));
  const change: store.FeedbackChange = {};
  if (body.rating === -1 || body.rating === 0 || body.rating === 1) change.rating = body.rating;
  if (typeof body.hidden === "boolean") change.hidden = body.hidden;
  if (body.click === true) change.click = true;
  if (typeof body.saved === "boolean") change.saved = body.saved;
  if (!Object.keys(change).length) return c.json({ error: "Nothing to record" }, 400);
  if (!store.recordFeedback(Number(c.req.param("id")), change)) return c.json({ error: "No such article" }, 404);
  // A reaction to an article the model hasn't reached yet gets its vector in the background.
  void embedPending().catch((e) => console.error("[embed] failed:", e));
  return c.body(null, 204);
});

app.get("/api/profile", (c) => c.json(profile()));

// Edits a reaction from the profile page. By URL, since the article itself may have been pruned.
app.patch("/api/reactions", async (c) => {
  type Body = { url?: unknown; rating?: unknown; hidden?: unknown };
  const body = await c.req.json<Body>().catch((): Body => ({}));
  const change: Pick<store.FeedbackChange, "rating" | "hidden"> = {};
  if (body.rating === -1 || body.rating === 0 || body.rating === 1) change.rating = body.rating;
  if (typeof body.hidden === "boolean") change.hidden = body.hidden;
  if (typeof body.url !== "string" || !Object.keys(change).length) return c.json({ error: "Nothing to change" }, 400);
  if (!store.changeReaction(body.url, change)) return c.json({ error: "No such reaction" }, 404);
  return c.body(null, 204);
});

app.post("/api/profile/reset", (c) => {
  store.resetProfile();
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
  type Body = { enabled?: unknown; title?: unknown };
  const body = await c.req.json<Body>().catch((): Body => ({}));
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
