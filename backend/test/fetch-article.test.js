/**
 * The article layer's job is to read a lot and keep a little. These tests
 * police the "keep a little" half, because that is the half that turns into a
 * copyright problem if it quietly stops being true.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  paragraphsFrom, distil, figuresFrom,
  MAX_QUOTES, MAX_QUOTE_WORDS, MAX_TOTAL_CHARS, MAX_QUOTED_SHARE,
} from "../src/layers/fetch-article.js";
import { buildCandidate } from "../src/bundle.js";
import { clusterItems } from "../src/layers/cluster.js";
import { MIXED_ITEMS, OUTLETS } from "./fixtures.js";

/** An invented article with the shapes that break naive extractors. */
const ARTICLE_HTML = `
<html><head><title>Ignore me</title><style>.x{color:red}</style></head>
<body>
  <nav><a href="/">Home</a><a href="/world">World</a></nav>
  <header>Northwind Wire</header>
  <article>
    <h1>Harbour authority raises dock fees</h1>
    <p>By A. Reporter</p>
    <p>The harbour authority approved a twelve per cent increase in dock fees on Tuesday evening, after a budget vote that split the council down the middle and ran past midnight.</p>
    <p>&ldquo;We have deferred this for three years and the maintenance backlog is now $28 million,&rdquo; said the authority&rsquo;s chair, defending the decision to operators who packed the gallery.</p>
    <p>Operators told the council the increase lands in the middle of the season and will be passed to customers, according to a submission filed before the vote.</p>
    <p>Share this article</p>
  </article>
  <aside><p>Related: ferry operators warn of route cuts across the region this winter season ahead.</p></aside>
  <footer><p>Copyright notice and a long boilerplate line that should not survive extraction at all.</p></footer>
</body></html>`;

test("extraction keeps prose and drops chrome", () => {
  const paras = paragraphsFrom(ARTICLE_HTML);
  const joined = paras.join(" ");

  assert.ok(joined.includes("twelve per cent"), "body paragraphs must survive");
  assert.ok(!joined.includes("Copyright notice"), "footer must be dropped");
  assert.ok(!joined.includes("color:red"), "style contents must be dropped");
  assert.ok(!joined.includes("Home"), "nav must be dropped");
  assert.ok(!joined.includes("Share this article"), "boilerplate must be dropped");
  assert.ok(!joined.includes("By A. Reporter"), "short byline lines must be dropped");
});

test("entities are decoded, not left as HTML escapes", () => {
  const paras = paragraphsFrom(ARTICLE_HTML);
  const joined = paras.join(" ");
  assert.ok(!joined.includes("&ldquo;"));
  assert.ok(joined.includes('"We have deferred this'));
});

test("the distillate stays inside every budget", () => {
  const { quotes, quotedWords, wordCount } = distil(paragraphsFrom(ARTICLE_HTML));

  assert.ok(quotes.length <= MAX_QUOTES, `kept ${quotes.length} quotes`);
  for (const q of quotes) {
    const words = q.split(/\s+/).length;
    assert.ok(words <= MAX_QUOTE_WORDS + 1, `quote ran to ${words} words: ${q}`);
  }
  const total = quotes.join("").length;
  assert.ok(total <= MAX_TOTAL_CHARS, `kept ${total} chars of quoted material`);
  assert.ok(quotedWords <= Math.floor(wordCount * MAX_QUOTED_SHARE) + MAX_QUOTE_WORDS,
    `quoted ${quotedWords} of ${wordCount} words`);
});

test("a SHORT article yields proportionally less, not the same fixed amount", () => {
  const short = paragraphsFrom(ARTICLE_HTML);
  const long = [...short, ...Array.from({ length: 30 }, (_, i) =>
    `Paragraph ${i} continues the account with enough words in it to read as ordinary reported prose rather than a caption or a navigation label.`)];

  const a = distil(short);
  const b = distil(long);

  assert.ok(b.wordCount > a.wordCount * 3, "fixture sanity: the long version is much longer");
  assert.ok(a.quotedWords / a.wordCount <= MAX_QUOTED_SHARE + 0.15,
    `short article gave away ${(100 * a.quotedWords / a.wordCount).toFixed(0)}%`);
  assert.ok(b.quotedWords / b.wordCount < a.quotedWords / a.wordCount,
    "the share quoted must fall as the article gets longer");
});

test("directly quoted speech is preferred over filler", () => {
  // Padded to a realistic article length so the proportional cap isn't the
  // thing under test here — selection order is.
  const padded = [
    ...paragraphsFrom(ARTICLE_HTML),
    ...Array.from({ length: 25 }, (_, i) =>
      `Background paragraph ${i} restates the schedule and the committee timetable in ordinary reported prose without quoting anyone directly at all.`),
  ];
  const { quotes } = distil(padded);
  assert.ok(quotes.length > 0);
  assert.ok(quotes[0].startsWith('"We have deferred this'),
    `attributed speech should rank first, got: ${quotes[0]}`);
  assert.ok(quotes.some(q => q.includes("maintenance backlog")),
    "at a realistic length the quote survives long enough to carry its point");
});

test("figures are pulled with enough context to be checkable", () => {
  const figures = figuresFrom("The backlog is now $28 million, up twelve per cent from 2025.");
  assert.ok(figures.some(f => f.value.includes("28")));
  for (const f of figures) assert.ok(f.context.split(/\s+/).length <= 21);
});

test("a candidate carries extracts but never the article body", () => {
  const roster = new Map(Object.values(OUTLETS).map(o => [o.id, o]));
  const cluster = clusterItems(MIXED_ITEMS, { windowHours: 72 }).find(c => c.outletCount === 3);

  const distilled = distil(paragraphsFrom(ARTICLE_HTML));
  const articles = new Map([[
    cluster.items[0].url,
    { ok: true, url: cluster.items[0].url, read: "full article read; short extracts retained", ...distilled, wordCount: 120 },
  ]]);

  const candidate = buildCandidate(cluster, roster, { articles });
  const enriched = candidate.sources.find(s => s.u === cluster.items[0].url);

  assert.equal(enriched.read, "full article read; short extracts retained");
  assert.ok(Array.isArray(enriched.quotes) && enriched.quotes.length);

  // The whole point: what lands in the candidate is an extract, not the piece.
  const quotedWords = (enriched.quotes ?? []).join(" ").split(/\s+/).filter(Boolean).length;
  assert.ok(quotedWords <= Math.floor(distilled.wordCount * MAX_QUOTED_SHARE) + MAX_QUOTE_WORDS,
    `candidate carried ${quotedWords} words of a ${distilled.wordCount}-word article`);

  const quotedChars = candidate.sources.reduce((n, s) => n + (s.quotes ?? []).join("").length, 0);
  assert.ok(quotedChars <= MAX_TOTAL_CHARS * candidate.sources.length,
    "quoted material must stay within budget per source");
});

test("sources that were not read say so, and say why", () => {
  const roster = new Map(Object.values(OUTLETS).map(o => [o.id, o]));
  const cluster = clusterItems(MIXED_ITEMS, { windowHours: 72 }).find(c => c.outletCount === 3);
  const articles = new Map([[cluster.items[1].url, { ok: false, error: "HTTP 403" }]]);

  const candidate = buildCandidate(cluster, roster, { articles });
  const blocked = candidate.sources.find(s => s.u === cluster.items[1].url);

  assert.equal(blocked.articleError, "HTTP 403");
  assert.match(blocked.read, /headline/, "a source whose article failed falls back to the honest lower tier");
});
