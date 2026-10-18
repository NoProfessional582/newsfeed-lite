# Newsfeed Lite

A small local crawler for tech news. You give it sites, topic pages or feed URLs. It stores a
**preview** of each recent article: headline, a 640×400 image, and a short highlight or the first few
lines. A local web page shows the previews, and each one links to the full article.

It's a lighter version of [news-crawler](https://github.com/NoProfessional582/news-crawler), without
Docker, Postgres, Redis, LLM enrichment or Telegram. It needs one Node process and one SQLite file.

## Run

Requires Node 24 or newer, which runs the TypeScript sources directly with no build step.

```bash
npm install
npm start          # http://localhost:4600
```

Open **Sources** and add URLs. Any of these work:

| You add | What happens |
|---|---|
| A site home page, like `https://thenewstack.io/` | Uses the feed the page advertises, or probes `/feed/`, `/rss.xml`, `/atom.xml`, … |
| A topic or category page, like `https://thenewstack.io/kubernetes/` | Uses a feed **scoped to that topic** if one exists (`/kubernetes/feed/`). Otherwise it scrapes the page. It never falls back to the site-wide feed. |
| A feed URL | Uses the feed directly |
| A page with no feed | **HTML mode**: collects article links from the page and extracts each one |

A crawl runs at startup, every `intervalMinutes`, and when you click **Refresh**. For a single
headless run, for example from a Windows scheduled task, use `npm run crawl`.

### Being polite to sites

- Requests to one host are spaced `perHostDelayMs` apart, and a run sends at most
  `maxRequestsPerHostPerRun` to any one host. This matters when several sources share a site. Articles
  over the budget are skipped and picked up next run.
- A **429** stops all requests to that host for the rest of the run. A `Retry-After` on a 429 or 503
  is honoured across runs too.
- Rate limits, 5xx errors and timeouts are treated as temporary. The source keeps its detected feed
  and shows the error until a later run succeeds. Other errors clear the feed so the next run detects
  it again.
- Feeds are fetched conditionally (`If-None-Match` / `If-Modified-Since`), so an unchanged feed
  answers with an empty 304. The validators are kept only when every item in the run was handled. If
  any were skipped over a budget or rate limit, the next run fetches the full feed so they get picked up.
- **Source health:** Sources shows each source's state. One that fails 3 runs in a row (2 if it has
  never worked) is marked failing, the Sources button shows a count, and **Remove them** clears every
  failing source at once.

## Reading

- **Saved:** the bookmark on a card keeps it under **Saved**, sorted by when you saved it. Saved
  articles are exempt from `retentionDays` pruning. They're still deleted with their source.
- **Read state:** articles you've opened are dimmed and marked "opened". **Unread only** leaves
  them out of every view.
- **Story groups:** when several sites report the same story, only the first report gets a card. The
  others appear under it as "Also covered by …" links. Two reports match when their embedding
  similarity plus a bonus for shared rare title words reaches 0.93 (`src/cluster.ts`), and they come
  from different sites within 3 days. The threshold is strict on purpose: on this project's data,
  same-story pairs scored 0.60–0.83 on embeddings alone, overlapping unrelated pieces on the same
  topic. Hiding the lead hides the whole story. Filtering by source shows that source's own reports
  ungrouped.
- **Search** ranks by meaning as well as words: "graphics card prices" finds an RTX 5080 pricing story
  that contains none of those words. Results containing every query word get a boost, more when the
  words are in the headline. Matches on meaning alone are labelled "Related to your search" and need
  a similarity of 0.4 (`src/search.ts`). Results are ordered by relevance in every view. If the model
  can't load, search falls back to plain keyword matching.

## How a preview is built

- **Headline:** `og:title`, then `<h1>`, then the feed title.
- **Image:** `og:image` / `twitter:image`, then the feed's `media:*` / enclosure / first `<img>`. It's
  cropped to 640×400 WebP using sharp's attention-based crop and saved in `data/images/`. If the
  download fails, the original image URL is used instead.
- **Highlight:** the feed summary or `og:description`, whichever is longer, if it's substantial (250+ characters). 
  Otherwise the first three paragraphs of the article body: the page's own marked-up body
  (`itemprop="articleBody"`, `#article-body`, …) when it has one, else what Readability extracts.
  Paragraphs and summaries that read like the author's bio ("Jane is a senior writer at…") are
  skipped. Trimmed to about 400 characters on a sentence boundary.
- **Dedup:** by canonical URL. Every URL that led to a stored article, the feed link as well as the
  canonical URL, is remembered in `seen_urls`, so it isn't fetched again and doesn't return as new
  after pruning. A URL is forgotten once it hasn't appeared in a crawl for `retentionDays`.

## For you

Each card has **👍 More like this**, **👎 Less like this** and **Hide**. Opening an article counts
as a mild 👍. After three reactions, the **For you** view ranks articles by what you've reacted to.

- **Embeddings:** each article's headline, preview and feed tags are turned into a vector by
  `all-MiniLM-L6-v2`, using [transformers.js](https://github.com/huggingface/transformers.js) in the
  same Node process. The ~23 MB model downloads once into `data/models/`. After that it loads from
  disk and remote fetching is turned off, so nothing leaves the machine.
- **Scoring:** an article scores by the weighted sentiment of its 8 nearest reactions, so separate
  interests don't average each other out. The score adds a small source-affinity term and a recency
  boost with a 3-day half-life. Every 6th slot goes to a fresh article the profile knows little
  about, so the feed keeps learning. The caption on each card says why it's there.
- **Persistence:** reactions live in a `feedback` table with their own copy of the article's text and
  vector, so your profile survives the `retentionDays` pruning. Hidden articles drop out of every view.
  Articles you've already rated, hidden, saved or opened are left out of For you.
- **Profile:** the **Profile** button shows what the ranking has learned. That covers your reaction
  counts, feed tags you lean toward or avoid (once a tag has two reactions), and how much you like
  each source. It lists every thumb and hide, and each one can be flipped, unhidden or forgotten,
  even after the article itself has been pruned. **Reset profile** forgets every reaction but keeps
  your saved articles.

### How reactions count

| Reaction | Weight |
|---|---|
| 👍 | +1 |
| 👎 | −1 |
| Hide (with no thumb) | −0.6 |
| Saved, not rated | +0.5 |
| Opened, not rated | +0.3 |

A thumb overrides everything else. Pressing the same thumb again clears it.

### Tuning

The weights are fixed by hand for now. They're constants at the top of `src/recommend.ts`:

| Constant | Value | Effect |
|---|---|---|
| `NEIGHBOURS` | 8 | How many of your nearest reactions vote on each article |
| `SIM_FLOOR` | 0.2 | Similarity below this counts as unrelated. MiniLM scores unrelated news around 0.0–0.2 |
| `SHRINK` | 0.3 | Pulls scores toward zero when the evidence is weak |
| `SOURCE_WEIGHT` | 0.25 | Weight of the source-affinity term |
| `RECENCY_WEIGHT` | 0.3 | Weight of the recency term |
| `HALF_LIFE_DAYS` | 3 | How fast that recency boost decays |
| `EXPLORE_EVERY` | 6 | Interval between exploration slots |
| `MIN_REACTIONS` | 3 | Reactions needed before For you ranks anything. Below that it shows the latest |

### API

- `GET /api/articles`: `view` (`latest`, `foryou` or `saved`), `q`, `source`, `days`, `unread=1`,
  `sort` (`newest`/`oldest`) and `limit` (1-200, default 60; larger values are capped). `days` counts
  back from now (0 or less means no limit; above 3650 counts as 3650). A `limit` that
  isn't a whole number from 1 up, or a `days` that isn't a number, gets HTTP 400. Pages are cursor-based: pass the response's `next` back as
  `after` to get the following page (`next` is null on the last one). Hiding an article between pages
  doesn't shift what comes next. Each row has `coverage`, the other sites' reports of its story.
- With `view=foryou`, each row also has `score` and `reason`, and the response includes `coldStart`
  and `reactions`. With `q`, results are ranked by relevance in any view. Ranked results are computed
  on the first page and later pages read that ranking, so reacting while you scroll doesn't
  reshuffle them. A ranking is kept until it goes unread for 30 minutes (or 24 newer ones push it
  out); after that its cursor gets HTTP 410 with `code: "cursor_expired"`, and the caller starts
  again without `after`. The UI does that by reloading from the first page.
- `POST /api/articles/:id/feedback`: a JSON body with any of `rating` (-1, 0 or 1), `hidden`
  (boolean), `saved` (boolean) or `click: true`.
- `GET /api/profile`: what the Profile page shows. `PATCH /api/reactions` with `url` and `rating`
  or `hidden` changes one reaction. `POST /api/profile/reset` forgets every reaction except saves.

### Not built yet

- **Learned weights:** a small logistic-regression model, trained on your own reactions, would replace
  the hand-set constants above. It would use the embedding similarity, source and feed tags as
  inputs. It's worth adding once there are about 50 reactions to learn from.
- **Keyword fallback:** a model based on source, tags and title words, with no embeddings. It was
  skipped because embeddings already work well with only a few reactions.
- **Source suggestions:** suggest new sites to add based on what you 👍, using the existing feed
  discovery.

## AI agents (MCP)

`src/mcp.ts` is an MCP server for local agent harnesses such as Hermes Agent, Claude Code or
Codex. Its `news_*` tools list articles in the latest, For you or Saved views, search, get one
article, see sources and their health, and see what the ranking has learned. With write access
(`NEWSFEED_MCP_ACCESS=write`, off by default) an agent can also rate, save, hide and mark
articles read, start a crawl, and add, pause or remove sources.

The MCP server runs over stdio and calls the newsfeed-lite server's API, so `npm start` must be
running. For Hermes, add it to `~/.hermes/config.yaml` and run `/reload-mcp`:

```yaml
mcp_servers:
  newsfeed:
    command: "node"   # or the full path, e.g. "C:\\Program Files\\nodejs\\node.exe"
    args: ["/path/to/newsfeed-lite/src/mcp.ts"]   # on Windows: "C:\\path\\to\\newsfeed-lite\\src\\mcp.ts"
    env:
      NEWSFEED_MCP_ACCESS: "write"   # leave out for only the news tools that look things up
```

Hermes names the tools `mcp_newsfeed_news_search` and so on.

| Variable | Default | Meaning |
|---|---|---|
| `NEWSFEED_URL` | `http://127.0.0.1:<port>` | Where newsfeed-lite is running |
| `NEWSFEED_MCP_ACCESS` | read only | `write` turns on the news tools that change things; anything else, or unset, leaves them off |

Article text comes from third-party sites, and an agent reading it could be steered by it, which
is why writes are opt-in. Every string a website supplied (titles, URLs, excerpts, authors, tags,
source names, crawl errors) sits inside a `third_party` object in tool results, and the server
tells agents to treat those as data, not instructions. `news_remove_source` deletes for good, and its description asks the agent to
confirm with you first. Hermes can also filter tools per server with `tools.include` /
`tools.exclude`.

## Config (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `port` | 4600 | The UI and API port, bound to 127.0.0.1 only |
| `intervalMinutes` | 60 | Auto-crawl interval while the server runs (0 turns it off) |
| `maxArticlesPerSource` | 20 | Newest items considered per source per run |
| `retentionDays` | 30 | Articles and images older than this are deleted |
| `concurrency` | 4 | Fetches running at once, across all sites |
| `perHostDelayMs` | 1000 | Minimum gap between requests to the same host |
| `maxRequestsPerHostPerRun` | 100 | Most requests one crawl run sends to one host, including images |
| `timeoutMs` | 15000 | Per-request timeout |
| `respectRobots` | true | Skip URLs that robots.txt disallows. The file is cached for 24 hours. If it can't be fetched (5xx, 429, timeout), that host waits for a later run |
| `userAgent` | … | The User-Agent header sent with requests |

## Safety

- There's no authentication, so the server listens on localhost only.
- Being on localhost doesn't stop other sites open in your browser from calling the API. The server
  rejects any `Host` that isn't a loopback name (DNS rebinding), cross-site `Origin`s, and writes
  that aren't `application/json`.
- URLs come from third-party feeds, so the fetcher refuses private and loopback addresses on every
  redirect hop. The check runs inside the connection's DNS lookup, so the address checked is the
  address connected to, and it covers IPv4-mapped IPv6 forms. That keeps a hostile feed from probing your LAN.
- Responses are size-capped (5 MB pages, 10 MB feeds, 8 MB images), and images over 40 MP are
  rejected before they're decoded.

## Layout

```
src/server.ts     Hono API + static UI          src/discover.ts  feed discovery, HTML link scraping
src/crawler.ts    crawl run orchestration       src/feed.ts      RSS 2.0 / RSS 1.0 / Atom parsing
src/extract.ts    article page → preview        src/fetcher.ts   polite, capped, checked HTTP GET
src/images.ts     thumbnail download + crop     src/db.ts        node:sqlite schema and queries
src/embed.ts      local sentence embeddings     src/recommend.ts "For you" ranking, profile
src/cluster.ts    same-story grouping           src/search.ts    semantic + keyword search
src/snapshots.ts  stable paging of rankings     test/            node:test suites (npm test)
src/mcp.ts        MCP server (news_* tools)
public/index.html the UI                        data/            database, images, model (gitignored)
```
