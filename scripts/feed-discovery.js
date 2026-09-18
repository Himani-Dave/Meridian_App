/**
 * feed-discovery.js — the pure parts of feed validation.
 *
 * Split out of validate-feeds.js so they can be tested. The script itself runs
 * top-level code and cannot be imported, which meant the logic that decides
 * whether something is a feed, and where a site says its feeds live, had no
 * tests at all. That logic is where the guessing happened.
 */

/**
 * Candidate feed URLs for the outlets that failed verification.
 *
 * These are CANDIDATES, not corrections. Nothing here is trusted: each is
 * fetched and must parse as a feed with items before it replaces anything, the
 * same bar as every other URL in the roster. Keyed by outlet id; tried before
 * the generic fallback paths.
 */
/**
 * Where to start looking for an outlet that has no feed url in the roster at
 * all. Reuters withdrew its public RSS in 2020 and Xinhua never had an entry,
 * so there is no origin to sniff without this.
 */
export const HOMEPAGES = {
  reuters: "https://www.reuters.com/world/",
  xinhua: "https://english.news.cn/",
};

export const ALTERNATES = {
  ap:            ["https://apnews.com/index.rss", "https://apnews.com/hub/world-news/rss", "https://apnews.com/rss"],
  reuters:       ["https://www.reutersagency.com/feed/?best-topics=world&post_type=best"],
  washtimes:     ["https://www.washingtontimes.com/rss/headlines/news/politics/", "https://www.washingtontimes.com/rss/headlines/news/"],
  torstar:   ["https://www.thestar.com/search/?f=rss&t=article&c=news&l=50&s=start_time&sd=desc"],
  "thewire-in":       ["https://thewire.in/rss/", "https://m.thewire.in/rss"],
  "indianexp": ["https://indianexpress.com/section/india/feed/", "https://indianexpress.com/section/world/feed/"],
  theprint:      ["https://theprint.in/feed", "https://theprint.in/rss"],
  swarajya:      ["https://swarajyamag.com/rss/all", "https://swarajyamag.com/commentary/feed"],
  haaretz:       ["https://www.haaretz.com/cmlink/1.4605102", "https://www.haaretz.com/srv/rss"],
  timesofisrael: ["https://www.timesofisrael.com/feed", "https://www.timesofisrael.com/rss"],
  xinhua:        ["https://english.news.cn/rss/world.xml", "https://english.news.cn/home.xml"],
  focustaiwan:   ["https://focustaiwan.tw/rss/all", "https://focustaiwan.tw/rss/politics.xml"],
};

/** Is this actually a feed, and does it have items? */
export function inspect(body, contentType) {
  const head = body.slice(0, 4000).toLowerCase();
  const isFeed =
    head.includes("<rss") || head.includes("<feed") || head.includes("<rdf:rdf") ||
    /application\/(rss|atom)\+xml/i.test(contentType);
  if (!isFeed) return { isFeed: false, items: 0 };
  const items =
    (body.match(/<item[\s>]/gi)?.length ?? 0) +
    (body.match(/<entry[\s>]/gi)?.length ?? 0);
  return { isFeed: true, items };
}

/**
 * Every feed a page declares about itself, in preference order.
 *
 * This used to return only the first <link> tag, and only ever looked at the
 * body of the URL that had already failed — it never fetched the homepage. So
 * an outlet that publishes its real feed URL in its own <head>, which is most
 * of them, was never asked. That is why guessing URLs had a 1-in-12 hit rate:
 * the sites were willing to say where their feeds were and nothing asked them.
 */
/**
 * Feeds that exist but are not the newsroom.
 *
 * WordPress — which most of these outlets run — declares a comments feed in the
 * same <head> as the article feed, immediately after it. Taking links in
 * document order would have quietly set The Print's roster entry to its comment
 * stream, which parses as a valid feed with items and would have passed every
 * check downstream.
 */
const NOT_THE_NEWSROOM = /\b(comments?|author|tag|tags|search|podcast|shop|jobs)\b/i;

export function sniffAllFeeds(html, base) {
  const found = [];
  const add = href => {
    if (!href) return;
    let abs;
    try { abs = new URL(href, base).href; } catch { return; }
    if (NOT_THE_NEWSROOM.test(new URL(abs).pathname)) return;
    found.push(abs);
  };

  // Declared alternates first — these are the outlet's own answer.
  for (const tag of html.match(/<link[^>]+>/gi) ?? []) {
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/application\/(?:rss|atom)\+xml/i.test(tag)) continue;
    add(tag.match(/href=["']([^"']+)["']/i)?.[1]);
  }

  // Then anything on the page that looks like a feed link.
  for (const m of html.matchAll(/href=["']([^"']*(?:\/feed|\/rss)[^"'?]*)["']/gi)) add(m[1]);

  return [...new Set(found)];
}
