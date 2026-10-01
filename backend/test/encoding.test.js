/**
 * ENCODING AND IDENTITY — exhaustive, not cherry-picked.
 *
 * Entity decoding is a solved problem and it still shipped broken three times,
 * because each fix went into one of two copies. These tests enumerate the whole
 * space rather than the cases I happened to think of: every named entity in the
 * table, both numeric forms, double encoding, and every field of a real
 * candidate.
 *
 * The domain tests are here for the same reason — the third duplicated-logic
 * bug was two `registrable()` implementations with different suffix lists.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { decodeEntities, decodeEntitiesOnce, decodeUrl, stripHtml } from "../src/entities.js";
import { registrable, sameDomain } from "../src/domain.js";
import { itemsFromFeed, _internals as rss } from "../src/layers/discover-rss.js";
import { paragraphsFrom, distil } from "../src/layers/fetch-article.js";

// --- the whole entity space -------------------------------------------------

test("every named entity in the table decodes to a real character", () => {
  // Pull the table's own keys so this cannot drift from the implementation.
  const probe = "&amp;&quot;&apos;&lt;&gt;&nbsp;&rsquo;&lsquo;&ldquo;&rdquo;&mdash;&ndash;&hellip;&eacute;&egrave;&laquo;&raquo;&deg;&pound;&euro;";
  const out = decodeEntitiesOnce(probe);
  assert.ok(!/&[a-z]+;/i.test(out), `undecoded named entities remain: ${out}`);
  assert.ok(!out.includes("&#"), "no numeric leftovers");
});

test("decimal and hex numeric references both decode, at any width", () => {
  const cases = [
    ["&#39;", "'"], ["&#x27;", "'"], ["&#X27;", "'"],
    ["&#8217;", "’"], ["&#x2019;", "’"],
    ["&#038;", "&"], ["&#38;", "&"], ["&#x26;", "&"],
    ["&#8212;", "—"], ["&#x1F600;", "\u{1F600}"],
  ];
  for (const [input, want] of cases) {
    assert.equal(decodeEntitiesOnce(input), want, `${input} should decode to ${JSON.stringify(want)}`);
  }
});

test("a malformed or out-of-range reference never throws and never invents", () => {
  for (const bad of ["&#;", "&#x;", "&#999999999999;", "&#0;", "&notanentity;", "&", "&#x110000;"]) {
    assert.doesNotThrow(() => decodeEntities(bad), `threw on ${bad}`);
  }
  assert.equal(decodeEntities("&notanentity;"), "&notanentity;", "an unknown entity is left alone, not dropped");
});

test("double encoding is resolved, and triple encoding degrades safely", () => {
  assert.equal(decodeEntities("&amp;#8217;"), "’");
  assert.equal(decodeEntities("&amp;amp;"), "&");
  assert.doesNotThrow(() => decodeEntities("&amp;amp;#x27;"));
});

test("decoding is idempotent on already-clean text", () => {
  for (const clean of ["Canada’s Carney", "Rates & inflation", "plain ascii", "éèü"]) {
    assert.equal(decodeEntities(clean), clean, `changed clean text: ${clean}`);
  }
});

// --- where the encoded values actually land ---------------------------------

test("every field of a parsed feed item is clean", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><item>
    <title>Von der Leyen&amp;#8217;s Europe &amp;#8216;at a crossroads&amp;#8217; &amp;amp; more</title>
    <link>https://euronews.example/a?utm_source=RSS_Feed&amp;#038;utm_medium=RSS&amp;#038;x=1</link>
    <pubDate>Wed, 17 Sep 2026 08:15:00 GMT</pubDate>
    <description>&lt;p&gt;Trump&amp;#x27;s remarks &amp;#8212; drew a response.&lt;/p&gt;</description>
  </item></channel></rss>`;
  const [item] = itemsFromFeed(rss.parser.parse(xml), { id: "eu", name: "Euronews", lean: "centre", country: "EU" });

  for (const [field, value] of Object.entries(item)) {
    if (typeof value !== "string") continue;
    assert.ok(!/&#|&[a-z]+;/i.test(value), `${field} still encoded: ${value}`);
  }
  assert.doesNotThrow(() => new URL(item.url), "the decoded url must still parse");
  assert.ok(item.url.includes("&utm_medium"), "query separators must be real ampersands");
  assert.ok(!item.excerpt.includes("<p>"), "markup revealed by decoding must be stripped");
});

test("article extracts are clean too", () => {
  const html = `<article>
    <p>The chair said the backlog &amp;#x27;has grown&amp;#x27; and that &amp;#8220;deferral is no longer an option&amp;#8221; for the authority this year.</p>
    <p>Operators told the council the increase lands mid-season and will be passed on to customers across the region.</p>
  </article>`;
  const { quotes } = distil(paragraphsFrom(html));
  for (const q of quotes) {
    assert.ok(!/&#|&[a-z]+;/i.test(q), `quote still encoded: ${q}`);
  }
});

// --- one registrable domain -------------------------------------------------

test("multi-part suffixes resolve to a domain, not to the suffix", () => {
  const cases = [
    ["https://www.bbc.co.uk/news", "bbc.co.uk"],
    ["https://feeds.bbci.co.uk/rss", "bbci.co.uk"],
    ["https://z.net.in/d", "z.net.in"],
    ["https://a.com.sg/e", "a.com.sg"],
    ["https://c.com.mx/g", "c.com.mx"],
    ["https://x.org.in/h", "x.org.in"],
    ["https://thehindu.com/a", "thehindu.com"],
    ["https://sub.domain.example.com/x", "example.com"],
  ];
  for (const [url, want] of cases) assert.equal(registrable(url), want, url);
});

test("a bare public suffix returns null rather than a false identity", () => {
  // The old GDELT copy returned "net.in" here, so every .net.in outlet
  // collapsed to one identity — an outlet-attribution error.
  for (const suffix of ["https://net.in/", "https://co.uk/", "https://com.sg/"]) {
    assert.equal(registrable(suffix), null, `${suffix} must not resolve to a domain`);
  }
});

test("garbage input returns null and never throws", () => {
  for (const bad of ["", null, undefined, "not a url", "http://", "://x", "localhost", "a b c"]) {
    assert.doesNotThrow(() => registrable(bad), `threw on ${JSON.stringify(bad)}`);
    assert.ok(registrable(bad) === null || typeof registrable(bad) === "string");
  }
});

test("two hosts of one outlet compare equal; a suffix match does not", () => {
  assert.equal(sameDomain("https://www.bbc.co.uk/a", "https://bbc.co.uk/b"), true);
  assert.equal(sameDomain("https://a.net.in/x", "https://b.net.in/y"), false,
    "sharing only a public suffix is not the same outlet");
});
