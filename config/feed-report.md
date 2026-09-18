# Feed validation report

Run: 2026-09-18T04:02:35.299Z
Verified: 42/54

## Balance by lean

- centre: 10/16 verified
- lean_left: 5/6 verified
- lean_right: 7/7 verified
- left: 4/6 verified
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
- **Toronto Star** (lean_left) — HTTP 429
  - tried: `https://www.thestar.com/feed/`
- **The Wire** (left) — 200 but not a feed (probably an HTML page)
  - tried: `https://thewire.in/rss`
- **Indian Express** (centre) — HTTP 403
  - tried: `https://indianexpress.com/feed/`
- **The Print** (centre) — 200 but not a feed (probably an HTML page)
  - tried: `https://theprint.in/feed/`
- **Swarajya** (right) — parses as a feed but has 0 items
  - tried: `https://swarajyamag.com/feed`
- **Haaretz** (left) — HTTP 404
  - tried: `https://www.haaretz.com/srv/htz--all-articles`
- **Times of Israel** (centre) — HTTP 403
  - tried: `https://www.timesofisrael.com/feed/`
- **Xinhua** (state) — no feed url in roster
  - tried: `(none)`
- **Focus Taiwan (CNA)** (centre) — HTTP 404
  - tried: `https://focustaiwan.tw/rss/politics`

## Redirects worth pinning

- **Washington Examiner**: `https://www.washingtonexaminer.com/feed` -> `https://www.washingtonexaminer.com/feed/`
- **National Post**: `https://nationalpost.com/feed/` -> `https://nationalpost.com/feed`
- **Western Standard**: `https://www.westernstandard.news/feed` -> `https://www.westernstandard.news/stories.rss`
- **JNS**: `https://www.jns.org/feed/` -> `https://www.jns.org/index.rss`
- **South China Morning Post**: `https://www.scmp.com/rss/91/feed` -> `https://www.scmp.com/rss/91/feed/`