const $ = (id) => document.getElementById(id);
const PAGE = 60;
// `next` is the server's cursor for the following page; `offset` only counts loaded cards for bento tile sizes.
let offset = 0, next = null, total = 0, sources = [], wasRunning = false, loadSeq = 0;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Escapes a link for an attribute; anything but http(s), such as a javascript: URL from a feed, becomes inert.
const href = (u) => (/^https?:\/\//i.test(String(u ?? "")) ? esc(u) : "#");

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }

// Bento tile sizes, repeated every 14 cards. In four columns each run packs into full bands:
// hero+tall+2 small (2 rows), wide+2 small (1 row), tall+hero+2 small (2 rows), 2 small+wide (1 row).
const BENTO = ["hero", "tall", "small", "small", "wide", "small", "small", "tall", "hero", "small", "small", "small", "small", "wide"];

// Each source gets one of Kinship's six section hues, so its label and small tiles stay recognisable.
const hue = (a) => `var(--hue-${((a.source_id ?? [...host(a.url)].reduce((n, c) => n + c.charCodeAt(0), 0)) % 6) + 1})`;

function card(a, i) {
  const img = a.image_path ? `/images/${encodeURIComponent(a.image_path)}` : a.image_url;
  const initial = esc((a.source_title || host(a.url)).trim()[0] || "?").toUpperCase();
  const thumb = img
    ? `<div class="thumb"><img loading="lazy" src="${esc(img)}" alt="" referrerpolicy="no-referrer" data-initial="${initial}"></div>`
    : `<div class="thumb empty">${initial}</div>`;
  const when = a.published_at ? ago(a.published_at) : `added ${ago(a.fetched_at)}`;
  // Other sites' reports of the same story. Outside the card's main link, since links can't nest.
  const coverage = a.coverage?.length
    ? `<div class="coverage">Also covered by ${a.coverage.map((c) =>
        `<a href="${href(c.url)}" target="_blank" rel="noopener noreferrer" data-id="${c.id}" title="${esc(`${c.source_title}: ${c.title}`)}">${esc(host(c.url))}</a>`).join(", ")}</div>`
    : "";
  return `<article class="card t-${BENTO[i % BENTO.length]}${a.clicks ? " read" : ""}" data-id="${a.id}" style="--h: ${hue(a)}">
    <a class="card-link" href="${href(a.url)}" target="_blank" rel="noopener noreferrer">
      ${thumb}
      <div class="body">
        <div class="meta">${seenUntil && Date.parse(a.fetched_at) > seenUntil ? `<span class="new-tag">New</span><span>·</span>` : ""}<span class="src">${esc(a.source_title || host(a.url))}</span>${when ? `<span>·</span><span>${when}</span>` : ""}${a.author ? `<span>·</span><span>${esc(a.author)}</span>` : ""}<span class="read-tag">· opened</span><span class="why">${esc(a.reason)}</span></div>
        <h2>${esc(a.title)}</h2>
        ${a.excerpt ? `<p>${esc(a.excerpt)}</p>` : ""}
      </div>
    </a>
    ${coverage}
    <div class="actions">
      <span class="reason" title="${esc(a.reason)}">${esc(a.reason)}</span>
      <button class="icon-btn" data-save aria-pressed="${!!a.saved}" aria-label="Save for later" title="Save for later">${ICON.save}</button>
      <button class="icon-btn" data-rate="1" aria-pressed="${a.rating === 1}" aria-label="More like this" title="More like this">${ICON.up}</button>
      <button class="icon-btn" data-rate="-1" aria-pressed="${a.rating === -1}" aria-label="Less like this" title="Less like this">${ICON.down}</button>
      <button class="icon-btn" data-hide aria-label="Hide" title="Hide">${ICON.hide}</button>
    </div>
  </article>`;
}

const ICON = {
  save: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`,
  up: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>`,
  down: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>`,
  hide: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.73 5.08A10.74 10.74 0 0 1 21.94 11.65a1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/></svg>`,
};

let view = "latest", layout = "bento", sort = "newest", unreadOnly = false;
try { const v = localStorage.getItem("view"); if (v === "foryou" || v === "saved") view = v; } catch {}
try { if (localStorage.getItem("sort") === "oldest") sort = "oldest"; } catch {}
try { unreadOnly = localStorage.getItem("unread") === "1"; } catch {}

// For you and search results are ordered by score, so the date sort only shows in Latest and Saved
// (where it's the date you saved). The date range applies everywhere.
const dateSorted = () => view !== "foryou" && !$("q").value.trim();
function syncSort() {
  $("sort").hidden = !dateSorted();
  $("sort").dataset.sort = sort;
  $("sort").querySelector("span").textContent = sort === "oldest" ? "Oldest" : "Newest";
  $("sort").setAttribute("aria-label", `Sort by ${view === "saved" ? "date saved" : "date"}: ${sort} first`);
  $("unread").setAttribute("aria-pressed", String(unreadOnly));
}
try { const l = localStorage.getItem("layout"); if (["bento", "grid", "list"].includes(l)) layout = l; } catch {}

function setView(v) {
  view = v;
  try { localStorage.setItem("view", v); } catch {}
  for (const b of document.querySelectorAll(".views button")) b.setAttribute("aria-pressed", String(b.dataset.view === v));
  syncSort();
  loadArticles();
}

// Tile sizes are already on every card, so switching layout is CSS only: no refetch.
function setLayout(l) {
  layout = l;
  try { localStorage.setItem("layout", l); } catch {}
  for (const id of ["feed", "gridNew", "grid"]) $(id).dataset.layout = l;
  for (const b of document.querySelectorAll(".layouts button")) b.setAttribute("aria-pressed", String(b.dataset.layout === l));
}

// Like a chat app's unread line: Latest draws a line under what was published since your last visit.
// A visit ends when the tab is hidden or closed; coming back after VISIT_GAP starts a new one, so a
// quick tab switch doesn't move the line. seenUntil is that boundary, in ms; null on a first visit.
const VISIT_GAP = 30 * 60e3;
let seenUntil = null, hiddenAt = null;
try { seenUntil = Number(localStorage.getItem("seenUntil")) || null; } catch {}
function leave() {
  hiddenAt = Date.now();
  try { localStorage.setItem("seenUntil", String(hiddenAt)); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) leave();
  else if (hiddenAt && Date.now() - hiddenAt > VISIT_GAP) { seenUntil = hiddenAt; loadArticles(); }
});
addEventListener("pagehide", leave);
$("markSeen").addEventListener("click", () => {
  seenUntil = Date.now();
  try { localStorage.setItem("seenUntil", String(seenUntil)); } catch {}
  loadArticles();
});

// Latest only, sorted by date and not searching, since the line splits a list ordered by publish date.
const splitNew = () => view === "latest" && dateSorted() && seenUntil;
const isNew = (a) => Date.parse(a.published_at ?? a.fetched_at) > seenUntil;
let tiles = { gridNew: 0, grid: 0 };

// Shows the line only once older cards have loaded too: until then the whole page is still new.
function syncNewLine() {
  const n = $("gridNew").querySelectorAll(".card").length;
  $("gridNew").hidden = !n;
  $("newLine").hidden = !(n && $("grid").querySelector(".card"));
  const when = new Date(seenUntil).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  $("newLineText").textContent = sort === "newest"
    ? `↑ ${n} new since your last visit · ${when}`
    : `↓ New since your last visit · ${when}`;
}

const feedback = (id, body) =>
  fetch(`/api/articles/${id}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function loadArticles(append = false) {
  if (append && !next) return;
  const params = new URLSearchParams({ limit: PAGE, view });
  if (append) params.set("after", next);
  if ($("q").value.trim()) params.set("q", $("q").value.trim());
  if ($("source").value) params.set("source", $("source").value);
  if ($("days").value) params.set("days", $("days").value);
  if (unreadOnly) params.set("unread", "1");
  if (dateSorted()) params.set("sort", sort);
  // A filter change or crawl reload can overlap a Load more; only the latest request may render.
  const seq = ++loadSeq;
  const res = await fetch(`/api/articles?${params}`);
  if (seq !== loadSeq) return;
  // A ranked list's cursor expires after 30 idle minutes; rank again from the first page.
  if (res.status === 410 && append) return loadArticles();
  const { total: t, rows, next: n, coldStart, reactions } = await res.json();
  if (seq !== loadSeq) return;
  if (!append) offset = 0;
  total = t;
  next = n;
  $("notice").hidden = !coldStart;
  if (coldStart) {
    const need = 3 - reactions;
    $("notice").textContent = `Rate ${need} more article${need === 1 ? "" : "s"} with 👍 or 👎 and For you will start ranking. Showing the latest for now.`;
  }
  if (!append) {
    $("gridNew").innerHTML = $("grid").innerHTML = "";
    tiles = { gridNew: 0, grid: 0 };
  }
  // Each grid starts its own bento pattern, so both pack into full bands.
  const split = splitNew(), html = { gridNew: "", grid: "" };
  for (const a of rows) {
    const g = split && isNew(a) ? "gridNew" : "grid";
    html[g] += card(a, tiles[g]++);
  }
  for (const g in html) $(g).insertAdjacentHTML("beforeend", html[g]);
  $("feed").dataset.sort = sort;
  syncNewLine();
  offset += rows.length;
  $("more").hidden = !next;
  const empty = !append && rows.length === 0;
  $("empty").hidden = !empty;
  $("feed").hidden = empty;
  if (empty) {
    const filtered = $("q").value || $("source").value || $("days").value || unreadOnly;
    $("empty").textContent = sources.length === 0
      ? "No sources yet. Open Sources and add a site, topic page or feed URL."
      : view === "saved" && !filtered ? "Nothing saved yet. Use the bookmark on any card to keep it here for later."
      : ($("q").value || $("source").value) ? "Nothing matches."
      : unreadOnly ? "You've opened everything here. Turn off Unread only to see it again."
      : $("days").value ? "Nothing in this date range. Try a wider one."
      : "No articles yet. Click Refresh to crawl your sources.";
  }
}

async function loadSources() {
  sources = await (await fetch("/api/sources")).json();
  const current = $("source").value;
  $("source").innerHTML = `<option value="">All sources</option>` +
    sources.map((s) => `<option value="${s.id}">${esc(s.title || host(s.url))}</option>`).join("");
  $("source").value = sources.some((s) => String(s.id) === current) ? current : "";
  const failing = sources.filter((s) => health(s).failing);
  $("sourcesBadge").hidden = !failing.length;
  $("sourcesBadge").textContent = failing.length;
  $("sourcesBtn").setAttribute("aria-label", failing.length ? `Sources, ${failing.length} failing` : "Sources");
  $("healthSummary").hidden = !failing.length;
  $("healthText").textContent = failing.length === 1
    ? "1 source keeps failing."
    : `${failing.length} sources keep failing.`;
  $("srcList").innerHTML = sources.length ? sources.map((s) => {
    const h = health(s);
    return `
    <li class="src-item${s.enabled ? "" : " off"}${h.failing ? " failing" : ""}">
      <div class="src-title">${esc(s.title || host(s.url))}${s.mode ? `<span class="tag">${s.mode === "feed" ? "RSS" : "HTML"}</span>` : ""}<span class="tag">${s.article_count} articles</span></div>
      <div class="src-url">${esc(s.url)}${s.feed_url && s.feed_url !== s.url ? ` → ${esc(s.feed_url)}` : ""}</div>
      <div class="health ${h.tone}">${esc(h.text)}</div>
      ${s.last_error ? `<div class="src-err">${esc(s.last_error)}</div>` : ""}
      <div class="src-actions">
        <button class="btn" data-toggle="${s.id}" data-enabled="${s.enabled}">${s.enabled ? "Pause" : "Resume"}</button>
        <button class="btn danger" data-del="${s.id}" aria-label="Remove ${esc(s.title || s.url)}">Remove</button>
      </div>
    </li>`;
  }).join("") : `<li class="hint">No sources yet.</li>`;
}

// A source is failing after 3 bad runs in a row, or 2 if it has never worked at all.
function health(s) {
  // last_ok_at only exists since health tracking began, so stored articles also count as having worked.
  const never = !s.last_ok_at && !s.article_count;
  const failing = s.fail_streak >= 3 || (never && s.fail_streak >= 2);
  if (!s.last_crawled_at) return { failing: false, tone: "", text: "Not crawled yet" };
  if (failing) {
    return { failing, tone: "bad", text: never
      ? `Has never worked · failed ${s.fail_streak} runs in a row`
      : `Failing · ${s.fail_streak} runs in a row${s.last_ok_at ? `, last worked ${ago(s.last_ok_at)}` : ""}` };
  }
  if (s.fail_streak) return { failing, tone: "warn", text: `Last run failed${s.last_ok_at ? ` · last worked ${ago(s.last_ok_at)}` : ""}` };
  return { failing, tone: "", text: `OK · checked ${ago(s.last_crawled_at)}` };
}

$("removeFailing").addEventListener("click", async () => {
  const failing = sources.filter((s) => health(s).failing);
  const n = failing.reduce((sum, s) => sum + (s.article_count ?? 0), 0);
  const ok = await ask({
    title: `Remove ${failing.length} failing source${failing.length === 1 ? "" : "s"}?`,
    body: `${failing.map((s) => s.title || host(s.url)).join(", ")}.${n ? ` Their ${n} stored articles will be deleted too.` : ""} Your 👍 and 👎 history is kept.`,
  });
  if (!ok) return;
  const results = await Promise.all(failing.map((s) => fetch(`/api/sources/${s.id}`, { method: "DELETE" })));
  const removed = results.filter((r) => r.ok).length;
  toast(removed === failing.length ? `Removed ${removed} source${removed === 1 ? "" : "s"}.` : `Removed ${removed} of ${failing.length}. Try again for the rest.`, null, removed === failing.length ? undefined : "err");
  await loadSources();
});

async function pollStatus() {
  const s = await (await fetch("/api/status")).json();
  $("refresh").disabled = s.running;
  $("refresh").textContent = s.running ? "Crawling…" : "Refresh";
  $("status").textContent = s.running
    ? `Crawling ${s.sourcesDone}/${s.sourcesTotal} sources…`
    : s.lastRunAt ? `Last crawl ${ago(s.lastRunAt)}, ${s.lastRunNew} new · ${total} article${total === 1 ? "" : "s"} · auto-refresh every ${s.intervalMinutes} min` : "";
  if (wasRunning && !s.running) { await loadSources(); await loadArticles(); pollStatus(); }
  else if (s.running) { if (offset === 0 || $("feed").querySelectorAll(".card").length < PAGE) loadArticles(); }
  wasRunning = s.running;
  setTimeout(pollStatus, s.running ? 2000 : 30000);
}

let qTimer;
$("q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { syncSort(); loadArticles(); }, 250); });
$("unread").addEventListener("click", () => {
  unreadOnly = !unreadOnly;
  try { localStorage.setItem("unread", unreadOnly ? "1" : "0"); } catch {}
  syncSort();
  loadArticles();
});
$("source").addEventListener("change", () => loadArticles());
$("days").addEventListener("change", () => loadArticles());
$("sort").addEventListener("click", () => {
  sort = sort === "newest" ? "oldest" : "newest";
  try { localStorage.setItem("sort", sort); } catch {}
  syncSort();
  loadArticles();
});
syncSort();
$("more").addEventListener("click", () => loadArticles(true));
for (const b of document.querySelectorAll(".views button")) b.addEventListener("click", () => setView(b.dataset.view));
for (const b of document.querySelectorAll(".views button")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
for (const b of document.querySelectorAll(".layouts button")) b.addEventListener("click", () => setLayout(b.dataset.layout));
setLayout(layout);

// Until the theme button is used, the page follows the OS setting, live. A click pins the other theme.
const darkOS = matchMedia("(prefers-color-scheme: dark)");
function syncTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  $("theme").setAttribute("aria-label", `Switch to ${next} theme`);
  $("theme").title = `Switch to ${next} theme`;
}
$("theme").addEventListener("click", () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch {}
  syncTheme();
});
darkOS.addEventListener("change", () => {
  let saved; try { saved = localStorage.getItem("theme"); } catch {}
  if (saved) return;
  document.documentElement.dataset.theme = darkOS.matches ? "dark" : "light";
  syncTheme();
});
syncTheme();

// Opening an article is a mild "interested" signal. A beacon survives the tab switching away.
// Coverage links log against their own article, the card link against the card's.
function logClick(e) {
  const link = e.target.closest(".card-link, .coverage a");
  if (!link || (e.type === "auxclick" && e.button !== 1)) return;
  const cardEl = link.closest(".card");
  const id = link.dataset.id ?? cardEl.dataset.id;
  if (link.classList.contains("card-link")) cardEl.classList.add("read");
  navigator.sendBeacon(`/api/articles/${id}/feedback`, new Blob([JSON.stringify({ click: true })], { type: "application/json" }));
}
$("feed").addEventListener("click", logClick);
$("feed").addEventListener("auxclick", logClick);

let toastTimer, undoHide;
const hideToast = () => { if ($("toast").matches(":popover-open")) $("toast").hidePopover(); };
// Undo is optional; tone "err" paints it in the danger color.
function toast(text, undo, tone) {
  $("toastText").textContent = text;
  undoHide = undo;
  $("toastUndo").hidden = !undo;
  $("toast").classList.toggle("err", tone === "err");
  // Re-showing moves it to the top of the top layer, above whichever modal opened since.
  hideToast();
  $("toast").showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}
$("toastUndo").addEventListener("click", () => { hideToast(); undoHide?.(); });

// In-page replacement for confirm(). Resolves true only when the confirm button was pressed;
// Cancel, Escape and a click on the backdrop all resolve false. It settles from those inputs directly
// rather than from the dialog's "close" event, which some embedded browsers never deliver.
let settleAsk;
function ask({ title, body, ok = "Remove" }) {
  settleAsk?.(false);
  $("confirmTitle").textContent = title;
  $("confirmBody").textContent = body;
  $("confirmOk").textContent = ok;
  $("confirmDlg").showModal();
  return new Promise((resolve) => (settleAsk = resolve));
}
function answer(yes) {
  if ($("confirmDlg").open) $("confirmDlg").close();
  const settle = settleAsk;
  settleAsk = null;
  settle?.(yes);
}
$("confirmDlg").addEventListener("submit", (e) => { e.preventDefault(); answer(e.submitter?.value === "ok"); });
$("confirmDlg").addEventListener("cancel", (e) => { e.preventDefault(); answer(false); });
$("confirmDlg").addEventListener("click", (e) => { if (e.target === e.currentTarget) answer(false); });

// Takes a card out of the list until undo. Once the change is recorded, an emptied page loads the
// next one, or shows the empty state if there is none.
async function removeCard(cardEl, record, message, undo) {
  const next = cardEl.nextSibling, parent = cardEl.parentNode;
  cardEl.remove();
  await record();
  syncNewLine();
  if (!$("feed").querySelector(".card")) await loadArticles();
  toast(message, async () => {
    parent.insertBefore(cardEl, next?.parentNode === parent ? next : null);
    $("feed").hidden = false;
    $("empty").hidden = true;
    syncNewLine();
    await undo();
  });
}

$("feed").addEventListener("click", async (e) => {
  const btn = e.target.closest(".actions button");
  if (!btn) return;
  const cardEl = btn.closest(".card");
  const id = cardEl.dataset.id;
  if ("save" in btn.dataset) {
    const on = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(on));
    // In Saved, unsaving takes the card out of the list, so it gets the same undo as a hide.
    if (!on && view === "saved") {
      await removeCard(cardEl, () => feedback(id, { saved: false }), "Removed from Saved.", () => {
        btn.setAttribute("aria-pressed", "true");
        return feedback(id, { saved: true });
      });
    } else {
      await feedback(id, { saved: on });
      if (on) toast("Saved for later. Find it under Saved.");
    }
  } else if (btn.dataset.rate) {
    const on = btn.getAttribute("aria-pressed") !== "true";
    const rating = on ? Number(btn.dataset.rate) : 0;
    for (const b of cardEl.querySelectorAll("[data-rate]")) b.setAttribute("aria-pressed", String(on && b === btn));
    await feedback(id, { rating });
  } else if ("hide" in btn.dataset) {
    await removeCard(cardEl, () => feedback(id, { hidden: true }), "Hidden. You'll see less like this.",
      () => feedback(id, { hidden: false }));
  }
});
$("refresh").addEventListener("click", async () => {
  await fetch("/api/crawl", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  wasRunning = true;
  $("refresh").disabled = true;
  setTimeout(pollStatus, 500);
});
$("sourcesBtn").addEventListener("click", () => $("dlg").showModal());

// ─── Profile: what For you has learned, with each reaction editable ────────
let profileDirty = false;
async function loadProfile() {
  const p = await (await fetch("/api/profile")).json();
  const c = p.counts;
  const stat = (n, label) => `<div class="stat"><b>${n}</b>${label}</div>`;
  const chips = (tags, neg) => tags.length
    ? `<div class="chips">${tags.map((t) => `<span class="chip${neg ? " neg" : ""}" title="${t.n} reactions">${esc(t.tag)}</span>`).join("")}</div>`
    : `<p class="muted">Nothing clear yet.</p>`;
  // Affinity runs from -1 to 1; the bar grows from the middle, green right and red left.
  const bar = (a) => {
    const w = Math.min(50, Math.abs(a) * 50);
    return `<div class="aff-bar"><span style="left:${a >= 0 ? 50 : 50 - w}%;width:${w}%;background:var(${a >= 0 ? "--ok" : "--danger"})"></span></div>`;
  };
  const state = (r) => [r.rating === 1 ? "👍" : r.rating === -1 ? "👎" : "", r.hidden ? "hidden" : ""].filter(Boolean).join(" · ");
  const need = p.minReactions - p.trained;
  $("profileBody").innerHTML = `
    <h3>Your reactions</h3>
    <div class="stats">${stat(c.up, "👍 More like this")}${stat(c.down, "👎 Less like this")}${stat(c.hidden, "Hidden")}${stat(c.opened, "Opened")}${stat(c.saved, "Saved")}</div>
    <p class="muted" style="margin-top:10px">${need > 0
      ? `For you starts ranking after ${need} more reaction${need === 1 ? "" : "s"}.`
      : `For you ranks from ${p.trained} signals: thumbs, hides, saves and opens.`}</p>
    <h3>Topics you lean toward</h3>${chips(p.likedTags)}
    <h3>Topics you avoid</h3>${chips(p.dislikedTags, true)}
    <h3>Sources</h3>
    ${p.sources.length ? `<div class="aff">${p.sources.map((s) => `<span class="aff-name">${esc(s.title)}</span>${bar(s.affinity)}<span class="aff-n">${s.n}</span>`).join("")}</div>`
      : `<p class="muted">React to a few articles to see which sources you favour.</p>`}
    <h3>Thumbs and hides</h3>
    ${p.reactions.length ? `<ul class="react-list">${p.reactions.map((r) => `
      <li class="react" data-url="${esc(r.url)}">
        <div class="react-text">
          <a class="react-title" href="${href(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>
          <span class="react-meta">${esc(r.source_title || host(r.url))} · ${state(r)} · ${ago(r.updated_at)}</span>
        </div>
        <button class="icon-btn" data-rate="1" aria-pressed="${r.rating === 1}" aria-label="More like this" title="More like this">${ICON.up}</button>
        <button class="icon-btn" data-rate="-1" aria-pressed="${r.rating === -1}" aria-label="Less like this" title="Less like this">${ICON.down}</button>
        ${r.hidden ? `<button class="btn" data-unhide>Unhide</button>` : ""}
        <button class="btn" data-forget title="Forget this reaction">Forget</button>
      </li>`).join("")}</ul>` : `<p class="muted">No thumbs or hides yet.</p>`}
    <div class="profile-foot"><button class="btn danger" id="resetProfile">Reset profile</button></div>`;
}

$("profileBtn").addEventListener("click", async () => { profileDirty = false; await loadProfile(); $("profileDlg").showModal(); });
$("profileClose").addEventListener("click", () => $("profileDlg").close());
// Reactions changed here can move articles in and out of the feed, so reload it on close.
$("profileDlg").addEventListener("close", () => { if (profileDirty) loadArticles(); });

$("profileBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.id === "resetProfile") {
    const ok = await ask({
      title: "Reset your profile?",
      body: "This forgets every 👍, 👎, hide and open, and For you goes back to showing the latest. Saved articles stay saved.",
      ok: "Reset",
    });
    if (!ok) return;
    await fetch("/api/profile/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    toast("Profile reset.");
  } else {
    const url = btn.closest(".react")?.dataset.url;
    if (!url) return;
    const change = btn.dataset.rate
      ? { rating: btn.getAttribute("aria-pressed") === "true" ? 0 : Number(btn.dataset.rate) }
      : "unhide" in btn.dataset ? { hidden: false }
      : { rating: 0, hidden: false };
    const r = await fetch("/api/reactions", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, ...change }) });
    if (!r.ok) return toast("Couldn't change that reaction. Try again.", null, "err");
  }
  profileDirty = true;
  await loadProfile();
});
$("close").addEventListener("click", () => $("dlg").close());
$("dlg").addEventListener("close", () => loadArticles());

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const hint = $("addHint");
  $("addBtn").disabled = true;
  hint.className = "hint";
  hint.textContent = "Looking for a feed… (this can take a few seconds)";
  try {
    const r = await fetch("/api/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: $("addUrl").value }) });
    const s = await r.json();
    if (!r.ok) throw new Error(s.error || "Could not add source");
    if (s.last_error) { hint.className = "hint err"; hint.textContent = `Added, but: ${s.last_error}`; }
    else hint.textContent = s.mode === "feed" ? `Added. Found a feed: ${s.feed_url}. Click Refresh to crawl.` : "Added. No feed found, so articles will be scraped from the page. Click Refresh to crawl.";
    $("addUrl").value = "";
    await loadSources();
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = err.message;
  } finally {
    $("addBtn").disabled = false;
  }
});

$("srcList").addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.del) {
    const s = sources.find((x) => String(x.id) === t.dataset.del);
    const name = s ? s.title || host(s.url) : "this source";
    const n = s?.article_count ?? 0;
    const ok = await ask({
      title: `Remove ${name}?`,
      body: `${n ? `Its ${n} stored article${n === 1 ? "" : "s"} and their images will be deleted too, including any you saved. ` : ""}Your 👍 and 👎 history is kept, so For you won't forget what you liked.`,
    });
    if (!ok) return;
    const r = await fetch(`/api/sources/${t.dataset.del}`, { method: "DELETE" });
    if (r.ok) toast(`Removed ${name}.`);
    else toast(`Couldn't remove ${name}. Try again.`, null, "err");
  } else if (t.dataset.toggle) {
    await fetch(`/api/sources/${t.dataset.toggle}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: t.dataset.enabled !== "1" }) });
  }
  await loadSources();
});

(async () => { await loadSources(); await loadArticles(); pollStatus(); })();

// A thumbnail that fails to load falls back to the source's initial. Delegated, since the
// Content-Security-Policy allows no inline handlers; "error" doesn't bubble, hence capture.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.initial) return;
  img.parentNode.className = "thumb empty";
  img.parentNode.textContent = img.dataset.initial;
}, true);
