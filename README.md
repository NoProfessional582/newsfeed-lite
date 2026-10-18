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

## How a preview is built

- **Headline:** `og:title`, then `<h1>`, then the feed title.
- **Image:** `og:image` / `twitter:image`, then the feed's `media:*` / enclosure / first `<img>`. It's
  cropped to 640×400 WebP using sharp's attention-based crop and saved in `data/images/`. If the
  download fails, the original image URL is used instead.
- **Highlight:** the feed summary or `og:description`, whichever is longer, if it's substantial (250+ characters). 
  Otherwise the first three paragraphs that Readability extracts. Trimmed to about 400 characters on
  a sentence boundary.
- **Dedup:** by canonical URL.

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
  vector, so your profile survives the `retentionDays` pruning. Hidden articles drop out of both views.

## Config (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `port` | 4600 | The UI and API port, bound to 127.0.0.1 only |
| `intervalMinutes` | 60 | Auto-crawl interval while the server runs (0 turns it off) |
| `maxArticlesPerSource` | 20 | Newest items considered per source per run |
| `retentionDays` | 30 | Articles and images older than this are deleted |
| `concurrency` | 4 | Fetches running at once, across all sites |
| `perHostDelayMs` | 1000 | Minimum gap between requests to the same host |
| `timeoutMs` | 15000 | Per-request timeout |
| `respectRobots` | true | Skip URLs that robots.txt disallows |
| `userAgent` | … | The User-Agent header sent with requests |

## Safety

- There's no authentication, so the server listens on localhost only.
- URLs come from third-party feeds, so the fetcher refuses private and loopback addresses on every
  redirect hop. That keeps a hostile feed from probing your LAN.
- Responses are size-capped (5 MB pages, 10 MB feeds, 8 MB images), and images over 40 MP are
  rejected before they're decoded.

## Layout

```
src/server.ts     Hono API + static UI          src/discover.ts  feed discovery, HTML link scraping
src/crawler.ts    crawl run orchestration       src/feed.ts      RSS 2.0 / RSS 1.0 / Atom parsing
src/extract.ts    article page → preview        src/fetcher.ts   polite, capped, checked HTTP GET
src/images.ts     thumbnail download + crop     src/db.ts        node:sqlite schema and queries
src/embed.ts      local sentence embeddings     src/recommend.ts "For you" ranking
public/index.html the UI                        data/            database, images, model (gitignored)
```
