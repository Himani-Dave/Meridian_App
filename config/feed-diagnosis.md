# Feed diagnosis

Run: 2026-10-02T01:18:12.096Z

Read-only. Nothing in the roster or the pipeline was changed by this run.

## Agents tested

- **current** — what the pipeline sends today
  `Meridian/0.1 (personal news briefing; +https://claude.ai/artifact/S4nCxu1mrWTLUr2CzrvjPz)`
- **compatible** — standard bot form: identifies itself, leads with the Mozilla token
  `Mozilla/5.0 (compatible; Meridian/0.1; +https://github.com/Himani-Dave/Meridian_App)`
- **browser** — DIAGNOSTIC ONLY — would misrepresent a bot as a person's browser
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36`

`browser` is here to identify the cause, not as a proposal. If an outlet
accepts only a string claiming to be Chrome, the finding is that it does not
want automated clients, and the honest response is to drop it or reach it
another way.

## Results

| Outlet | URL | source | current | compatible | browser | verdict |
|---|---|---|---|---|---|---|
| Associated Press | `https://apnews.com/hub/ap-top-news/rss` | roster | HTTP 403 | HTTP 403 | HTTP 403 | fails under every agent — not a User-Agent problem |
| Reuters | `(none)` | - | - | - | - | no candidate url |
| Axios | `https://api.axios.com/feed/` | roster | robots.txt | robots.txt | robots.txt | robots.txt forbids it — not ours to take |
| Washington Times | `https://www.washingtontimes.com/rss/headlines/news/world/` | roster | HTTP 403 | HTTP 403 | HTTP 403 | fails under every agent — not a User-Agent problem |
| Toronto Star | `(none)` | - | - | - | - | no candidate url |
| CBC News | `https://www.cbc.ca/webfeed/rss/rss-world` | roster | HTTP 403 | timeout after 20000ms | OK (20 items) | only a browser string works — the outlet is refusing automated clients |
| CBC News | `https://www.cbc.ca/rss/` | declared (seen as browser) | HTTP 403 | timeout after 20000ms | 200, not a feed | fails under every agent — not a User-Agent problem |
| Le Devoir | `https://www.ledevoir.com/rss/manchettes.xml` | roster | HTTP 403 | OK (40 items) | OK (40 items) | **fixed by the compatible agent** — safe to deploy |
| The Wire | `https://thewire.in/rss` | roster | 200, not a feed | 200, not a feed | 200, not a feed | url is wrong, not a client problem |
| The Wire | `https://thewire.in/` | feed_index (a page, probed as-is) | 200, not a feed | 200, not a feed | 200, not a feed | url is wrong, not a client problem |
| Indian Express | `https://indianexpress.com/feed/` | roster | HTTP 403 | HTTP 403 | HTTP 403 | fails under every agent — not a User-Agent problem |
| Indian Express | `https://indianexpress.com/rss/` | feed_index (a page, probed as-is) | HTTP 403 | HTTP 403 | HTTP 403 | fails under every agent — not a User-Agent problem |
| The Print | `https://theprint.in/feed/` | roster | 200, not a feed | 200, not a feed | 200, not a feed | url is wrong, not a client problem |
| The Print | `https://theprint.in/` | feed_index (a page, probed as-is) | 200, not a feed | 200, not a feed | 200, not a feed | url is wrong, not a client problem |
| The Print | `https://theprint.in/web-stories/feed/` | declared (seen as current) | 200, not a feed | 200, not a feed | 200, not a feed | url is wrong, not a client problem |
| Business Standard | `https://www.business-standard.com/rss/home_page_top_stories.` | roster | HTTP 403 | HTTP 403 | OK (10 items) | only a browser string works — the outlet is refusing automated clients |
| Business Standard | `https://www.business-standard.com/rss-feeds/listing` | declared (seen as browser) | HTTP 403 | HTTP 403 | 200, not a feed | fails under every agent — not a User-Agent problem |
| Swarajya | `https://swarajyamag.com/feed` | roster | feed, 0 items | feed, 0 items | feed, 0 items | fails under every agent — not a User-Agent problem |
| The Times of India | `https://timesofindia.indiatimes.com/rss.cms` | feed_index (a page, probed as-is) | 200, not a feed | 200, not a feed | 200, not a feed | url is wrong, not a client problem |
| The Times of India | `https://timesofindia.indiatimes.com/feedback.cms` | declared (seen as current) | 200, not a feed | 200, not a feed | 200, not a feed | url is wrong, not a client problem |
| Times of Israel | `https://www.timesofisrael.com/feed/` | roster | robots.txt | robots.txt | robots.txt | robots.txt forbids it — not ours to take |
| Xinhua | `(none)` | - | - | - | - | no candidate url |

## What to do with this

- **fixed by the compatible agent** — change the one User-Agent in `backend/src/http.js`.
- **url is wrong** — the working url from the `source` column goes in the roster.
- **robots.txt forbids it** — the outlet has said no. Drop it from the roster.
- **only a browser string works** — treat as a refusal; do not impersonate a browser.
- **fails under every agent** — something else: IP blocking, JS challenge, or the feed is gone.
