/**
 * Feed discovery — asking a site where its feeds are, instead of guessing.
 *
 * Guessing URLs had a 1-in-12 hit rate across the outlets that failed
 * validation, and every remaining gap was Indian: The Hindu, Indian Express,
 * The Print, The Wire, Scroll.in, Swarajya, Organiser. The cause was not hard
 * sites — it was that nothing ever fetched their homepages and read the
 * <link rel="alternate"> tags they publish about themselves.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { sniffAllFeeds, inspect, ALTERNATES, isSearchEndpoint } from "../../scripts/feed-discovery.js";

// --- what a page says about itself -----------------------------------------

test("declared alternates are found and relative hrefs resolved", () => {
  const html = `
    <head>
      <link rel="canonical" href="https://thewire.in/"/>
      <link rel="stylesheet" href="/assets/app.css"/>
      <link rel="alternate" type="application/rss+xml" title="The Wire" href="/rss/feed.xml"/>
    </head>`;
  assert.deepEqual(sniffAllFeeds(html, "https://thewire.in"), ["https://thewire.in/rss/feed.xml"]);
});

test("a WordPress comments feed is not mistaken for the newsroom", () => {
  // Both alternates are valid feeds with items; document order would pick wrong.
  const html = `
    <link rel="alternate" type="application/rss+xml" title="ThePrint Feed" href="https://theprint.in/feed/"/>
    <link rel="alternate" type="application/rss+xml" title="ThePrint Comments Feed" href="https://theprint.in/comments/feed/"/>`;
  const found = sniffAllFeeds(html, "https://theprint.in");
  assert.deepEqual(found, ["https://theprint.in/feed/"]);
  assert.ok(!found.some(u => u.includes("comments")), "a comment stream is not an outlet's coverage");
});

test("author, tag and podcast feeds are excluded too", () => {
  const html = [
    '<link rel="alternate" type="application/rss+xml" href="/feed/"/>',
    '<link rel="alternate" type="application/rss+xml" href="/author/staff/feed/"/>',
    '<link rel="alternate" type="application/rss+xml" href="/tag/elections/feed/"/>',
    '<link rel="alternate" type="application/rss+xml" href="/podcast/rss"/>',
  ].join("\n");
  assert.deepEqual(sniffAllFeeds(html, "https://scroll.in"), ["https://scroll.in/feed/"]);
});

test("stylesheets and canonicals are never treated as feeds", () => {
  const html = `
    <link rel="stylesheet" type="text/css" href="/a.css"/>
    <link rel="canonical" href="https://thehindu.com/"/>
    <link rel="alternate" hreflang="ta" href="https://tamil.thehindu.com/"/>`;
  assert.deepEqual(sniffAllFeeds(html, "https://thehindu.com"), [],
    "an hreflang alternate is a translation, not a feed");
});

test("feed-looking anchors are picked up as a fallback", () => {
  const html = `<a href="/rss">RSS</a> <a href="/about">About</a> <a href="https://indianexpress.com/section/india/feed/">India feed</a>`;
  const found = sniffAllFeeds(html, "https://indianexpress.com");
  assert.ok(found.includes("https://indianexpress.com/rss"));
  assert.ok(found.includes("https://indianexpress.com/section/india/feed/"));
  assert.ok(!found.some(u => u.endsWith("/about")));
});

test("duplicates collapse", () => {
  const html = `
    <link rel="alternate" type="application/rss+xml" href="/feed/"/>
    <a href="/feed/">RSS</a>`;
  assert.equal(sniffAllFeeds(html, "https://swarajyamag.com").length, 1);
});

// --- is it actually a feed -------------------------------------------------

test("RSS, Atom and RDF are recognised and items counted", () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>A</title></item><item><title>B</title></item></channel></rss>`;
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title></entry></feed>`;
  const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><item><title>A</title></item></rdf:RDF>`;

  assert.deepEqual(inspect(rss, "application/xml"), { isFeed: true, items: 2 });
  assert.deepEqual(inspect(atom, "application/atom+xml"), { isFeed: true, items: 1 });
  assert.equal(inspect(rdf, "text/xml").isFeed, true);
});

test("an HTML page is not a feed, whatever its content type claims", () => {
  const html = `<!doctype html><html><head><title>The Print</title></head><body><div class="item">x</div></body></html>`;
  assert.equal(inspect(html, "text/html").isFeed, false);
});

test("an empty feed is recognised as a feed with no items", () => {
  const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>Swarajya</title></channel></rss>`;
  assert.deepEqual(inspect(empty, "application/rss+xml"), { isFeed: true, items: 0 });
});

// --- the candidate list stays honest ---------------------------------------

test("every candidate list is keyed to a real roster id", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(await readFile(join(here, "..", "..", "config", "sources.json"), "utf8"));
  const ids = new Set([...config.outlets, ...config.primary].map(e => e.id));

  for (const key of Object.keys(ALTERNATES)) {
    assert.ok(ids.has(key), `ALTERNATES key "${key}" matches no roster id — it would silently do nothing`);
  }
});

// --- search endpoints are not feeds ----------------------------------------
//
// The Toronto Star's classic RSS is a search query. It returned a valid feed
// once, so it passed validation and was written into the roster; the next run
// got HTTP 429. Validation that accepts a URL a site will rate-limit is
// validation that lies.

test("a search endpoint is rejected however feed-like it looks", () => {
  assert.equal(isSearchEndpoint("https://www.thestar.com/search/?f=rss&t=article&c=news&l=50"), true);
  assert.equal(isSearchEndpoint("https://example.com/search/rss"), true);
  assert.equal(isSearchEndpoint("https://example.com/feed?q=ukraine"), true, "a query feed is a search");
});

test("WordPress's one legitimate query-string feed still passes", () => {
  assert.equal(isSearchEndpoint("https://example.com/?feed=rss2"), false);
  assert.equal(isSearchEndpoint("https://example.com/feed/"), false);
  assert.equal(isSearchEndpoint("https://example.com/rss.xml"), false);
});

test("sniffing skips search links and keeps the real feed", () => {
  const html = `
    <a href="/search/?f=rss&t=article&c=news">RSS by search</a>
    <link rel="alternate" type="application/rss+xml" href="/feed/"/>`;
  assert.deepEqual(sniffAllFeeds(html, "https://thestar.com"), ["https://thestar.com/feed/"]);
});

test("no candidate list offers a search endpoint", () => {
  for (const [id, urls] of Object.entries(ALTERNATES)) {
    for (const u of urls) {
      assert.equal(isSearchEndpoint(u), false, `ALTERNATES.${id} offers a search endpoint: ${u}`);
    }
  }
});
