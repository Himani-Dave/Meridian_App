# Feed validation report

Run: 2026-09-18T05:50:40.689Z
Verified: 41/54

## Balance by lean

- centre: 9/16 verified
- lean_left: 5/6 verified
- lean_right: 7/7 verified
- left: 5/6 verified
- pro_sovereignty: 1/1 verified
- right: 8/11 verified
- state: 1/2 verified
- varies: 3/3 verified

## Failures

- **Associated Press** (centre) — HTTP 403
  - tried: `https://apnews.com/hub/ap-top-news/rss`
- **Reuters** (centre) — no feed url in roster
  - tried: `(none)`
- **Washington Times** (right) — HTTP 403
  - tried: `https://www.washingtontimes.com/rss/headlines/news/world/`
- **Toronto Star** (lean_left) — HTTP 429
  - tried: `https://www.thestar.com/search/?f=rss&t=article&c=news&l=50&s=start_time&sd=desc`
- **CBC News** (centre) — timeout after 15000ms
  - tried: `https://www.cbc.ca/webfeed/rss/rss-world`
- **Western Standard** (right) — parses as a feed but has 0 items
  - tried: `https://www.westernstandard.news/stories.rss`
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

## Redirects worth pinning

- **Haaretz**: `https://www.haaretz.com/cmlink/1.4605102` -> `https://www.haaretz.com/srv/haaretz-latest-headlines`