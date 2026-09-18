# Feed validation report

Run: 2026-09-18T04:54:06.436Z
Verified: 42/54

## Balance by lean

- centre: 8/16 verified
- lean_left: 6/6 verified
- lean_right: 7/7 verified
- left: 5/6 verified
- pro_sovereignty: 1/1 verified
- right: 9/11 verified
- state: 1/2 verified
- varies: 3/3 verified

## Failures

- **Associated Press** (centre) — HTTP 403
  - tried: `https://apnews.com/hub/ap-top-news/rss`
- **Reuters** (centre) — no feed url in roster
  - tried: `(none)`
- **Washington Times** (right) — HTTP 403
  - tried: `https://www.washingtontimes.com/rss/headlines/news/world/`
- **CBC News** (centre) — timeout after 15000ms
  - tried: `https://www.cbc.ca/webfeed/rss/rss-world`
- **The Wire** (left) — 200 but not a feed (probably an HTML page)
  - tried: `https://thewire.in/rss`
- **Indian Express** (centre) — HTTP 403
  - tried: `https://indianexpress.com/feed/`
- **The Print** (centre) — 200 but not a feed (probably an HTML page)
  - tried: `https://theprint.in/feed/`
- **Business Standard** (centre) — HTTP 403
  - tried: `https://www.business-standard.com/rss/home_page_top_stories.rss`
- **Swarajya** (right) — parses as a feed but has 0 items
  - tried: `https://swarajyamag.com/feed`
- **Times of Israel** (centre) — HTTP 403
  - tried: `https://www.timesofisrael.com/feed/`
- **Xinhua** (state) — no feed url in roster
  - tried: `(none)`
- **Focus Taiwan (CNA)** (centre) — HTTP 404
  - tried: `https://focustaiwan.tw/rss/politics`

## Redirects worth pinning

- **EUobserver**: `https://euobserver.com/feed` -> `https://euobserver.com/feed/`