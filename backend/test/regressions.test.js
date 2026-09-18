/**
 * Regressions found by the first real ingestion run (2026-09-18).
 *
 * Both bugs here were invisible to the fixture-based tests and only appeared
 * against 642 real articles from 40 live feeds. Each one is now pinned.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { _internals as http, robotsPatternToRegex } from "../src/http.js";
import { isBoilerplate, isDigest, clusterItems, tokenise, normaliseTitle } from "../src/layers/cluster.js";
import { _internals as rss } from "../src/layers/discover-rss.js";
import { extractQuantities, findNumericConflicts } from "../src/bundle.js";

const { parseRobots, robotsAllows } = http;

// --- robots.txt wildcards -------------------------------------------------
//
// The first run refused 14 verified feeds — Guardian, NY Post, Le Figaro, FAZ,
// Al Jazeera, SCMP, The Hindu, Politico EU, Organiser and more — because
// `Disallow: /*?` was truncated at the first `*` into `Disallow: /`. That
// removed several right-leaning outlets and skewed the whole run's balance.

test("a wildcard rule does not become a site-wide ban", () => {
  const rules = parseRobots(`
User-agent: *
Disallow: /*?
Disallow: /*.pdf$
Disallow: /admin
`);
  assert.equal(robotsAllows(rules, "/news/world/rss.xml"), true, "RSS must stay reachable");
  assert.equal(robotsAllows(rules, "/feed/"), true);
  assert.equal(robotsAllows(rules, "/search?q=x"), false, "query strings are genuinely disallowed");
  assert.equal(robotsAllows(rules, "/report.pdf"), false, "the $ anchor still applies");
  assert.equal(robotsAllows(rules, "/admin/users"), false);
});

test("a real site-wide ban is still honoured", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /\n");
  assert.equal(robotsAllows(rules, "/feed"), false);
  assert.equal(robotsAllows(rules, "/"), false);
});

test("Allow overrides a broader Disallow", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/public-feed.xml\n");
  assert.equal(robotsAllows(rules, "/private/secret"), false);
  assert.equal(robotsAllows(rules, "/private/public-feed.xml"), true);
});

test("rules aimed at other crawlers are ignored", () => {
  const rules = parseRobots("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n");
  assert.equal(robotsAllows(rules, "/feed"), true, "a ban on GPTBot is not a ban on us");
  assert.equal(robotsAllows(rules, "/admin"), false);
});

test("patterns compile to the right shape", () => {
  assert.ok(robotsPatternToRegex("/*?").test("/a?b"));
  assert.ok(!robotsPatternToRegex("/*.pdf$").test("/a.pdf.html"), "$ must anchor");
  assert.ok(robotsPatternToRegex("/a.b").test("/a.b"));
  assert.ok(!robotsPatternToRegex("/a.b").test("/axb"), ". must be literal, not a wildcard");
});

// --- recurring non-stories -------------------------------------------------
//
// The first run produced a three-outlet "story" made of a Democracy Now!
// headlines digest and two Haaretz daily cartoons, which share enough
// boilerplate wording to pass the similarity threshold.

test("recurring formats are recognised and real headlines are not", () => {
  for (const t of [
    "Headlines for September 16, 2026",
    "Daily Cartoon, September 18, 2026",
    "Watch: European Commissioners react to von der Leyen's speech",
    "The Week in Pictures",
    "News in brief",
  ]) assert.equal(isBoilerplate(t), true, `should be filtered: ${t}`);

  for (const t of [
    "UN experts say grounds to believe US committed war crimes in Iran strikes",
    "What we know about the Kosovo war crimes verdict",
    "Canada welcomes EU proposal to become an associate member",
    "Hague court sentences Kosovo's former president to 25 years",
  ]) assert.equal(isBoilerplate(t), false, `should be kept: ${t}`);
});

test("a digest and two cartoons no longer form a story", () => {
  const item = (id, outlet, title) => ({
    outletId: id, outlet, lean: "centre", country: "US",
    title, url: `https://${id}.example/${encodeURIComponent(title).slice(0, 20)}`,
    excerpt: "September 2026 roundup of the day's items and pictures.",
    publishedAt: "2026-09-17T09:00:00Z", retrievedAt: "2026-09-17T12:00:00Z", via: "rss",
  });

  const clusters = clusterItems([
    item("dn", "Democracy Now!", "Headlines for September 16, 2026"),
    item("hz", "Haaretz", "Daily Cartoon, September 18, 2026"),
    item("tt", "Taipei Times", "Daily Cartoon, September 17, 2026"),
  ], { windowHours: 72 });

  assert.equal(clusters.length, 0, "every item was boilerplate, so there is no story here");
});

// --- digests bridging unrelated stories ------------------------------------
//
// The second real run fused the Fed rate rise and the Canada-EU associate
// membership offer into one six-outlet cluster. The only link between them was
// NPR's Up First digest, whose headline names both.

test("a digest is recognised by its headline or its url", () => {
  assert.equal(isDigest({ title: "The Fed raises interest rates. And, EU proposes Canada become an 'associate member'", url: "https://npr.org/x" }), true);
  assert.equal(isDigest({ title: "Up First briefing", url: "https://npr.org/2026/09/17/up-first-newsletter-federal-reserve" }), true);
  assert.equal(isDigest({ title: "US Federal Reserve raises interest rates for the first time since 2023", url: "https://theguardian.com/a" }), false);
  assert.equal(isDigest({ title: "Canada welcomes EU proposal to become associate member", url: "https://bbc.co.uk/news/x" }), false);
});

test("a digest cannot chain two unrelated stories into one cluster", () => {
  const mk = (id, outlet, title, excerpt, url = `https://${id}.example/a`) => ({
    outletId: id, outlet, lean: "centre", country: "US", title, url, excerpt,
    publishedAt: "2026-09-17T09:00:00Z", retrievedAt: "2026-09-17T12:00:00Z", via: "rss",
  });

  const fedAndEu = [
    mk("guardian", "Guardian US", "US Federal Reserve raises interest rates for the first time since 2023",
       "The Federal Reserve lifted its benchmark interest rate, citing inflation that is too high."),
    mk("bbc", "BBC News", "US interest rates raised for first time in three years",
       "The Federal Reserve raised interest rates, saying inflation is too high and has been for too long."),
    mk("globe", "Globe and Mail", "What does it mean for Canada to become EU's first associate member?",
       "Von der Leyen said she wanted to open the door for Canada to become the European Union's first associate member."),
    mk("euobs", "EUobserver", "Canada's Carney gets the red carpet treatment and EU associate member offer",
       "Carney was offered associate member status by the European Union in Strasbourg."),
    // the bridge
    mk("npr", "NPR", "The Fed raises interest rates. And, EU proposes Canada become an 'associate member'",
       "Up First: the Federal Reserve raised interest rates, and the European Union proposed Canada become an associate member.",
       "https://npr.org/2026/09/17/up-first-newsletter-federal-reserve"),
  ];

  const clusters = clusterItems(fedAndEu, { windowHours: 72 });
  for (const c of clusters) {
    const titles = c.items.map(i => i.title).join(" ").toLowerCase();
    const hasFed = titles.includes("interest rates");
    const hasEu = titles.includes("associate member");
    assert.ok(!(hasFed && hasEu),
      "no cluster may contain both the Fed story and the Canada-EU story: " + c.items.map(i => i.outlet).join(", "));
  }
  assert.ok(!clusters.some(c => c.items.some(i => isDigest(i))), "the digest itself must not appear in any cluster");
});

// --- range endpoints are not disagreements ---------------------------------
//
// The same run reported four "conflicts" on the Fed story by comparing one
// outlet's "3.75% to 4%" against another's "3.5%-3.75%".

test("range endpoints are flagged and excluded from conflict detection", () => {
  const q = extractQuantities("Rates were hiked to 3.75%-4% from 3.5%-3.75% by the Fed.");
  assert.ok(q.length >= 3);
  assert.ok(q.every(x => x.inRange), "every endpoint in a range must be marked");

  const item = (outlet, excerpt) => ({ outlet, title: "Fed raises rates", excerpt, url: `https://${outlet}.x/a` });
  const bogus = findNumericConflicts([
    item("Guardian", "The Fed lifted its rate by a quarter point to a range of 3.75% to 4% on Wednesday."),
    item("BBC", "Rates were hiked to 3.75%-4% from 3.5%-3.75% by the Federal Reserve board."),
  ]);
  assert.equal(bogus.length, 0, "range endpoints must not be reported as a disagreement");
});

test("a genuine single-value disagreement is still caught", () => {
  const item = (outlet, excerpt) => ({ outlet, title: "Dock fees rise", excerpt, url: `https://${outlet}.x/a` });
  const real = findNumericConflicts([
    item("Northwind", "The harbour authority approved a dock fee increase worth $20 million to operators."),
    item("Meridianer", "Council split over the harbour dock fee increase, which operators value at $28 million."),
  ]);
  assert.equal(real.length, 1, "the $20m vs $28m conflict must survive the range exclusion");
});

// --- double-encoded feed entities ------------------------------------------

test("double-encoded entities are decoded out of titles", () => {
  assert.equal(rss.stripHtml("Canada&#8217;s Carney gets the red carpet treatment"),
               "Canada\u2019s Carney gets the red carpet treatment");
  assert.equal(rss.stripHtml("Von der Leyen&amp;#8217;s Europe ends at the chamber door"),
               "Von der Leyen\u2019s Europe ends at the chamber door");
  assert.equal(rss.stripHtml("Rates &amp; inflation &#x2014; what next"),
               "Rates & inflation \u2014 what next");
});

test("entity damage no longer blocks clustering of the same story", () => {
  // IDF is meaningless on a two-document corpus — every shared term scores
  // identically — so this runs against a realistic background of unrelated
  // items, the way the real pipeline does.
  const mk = (id, outlet, title, excerpt) => ({
    outletId: id, outlet, lean: "centre", country: "CA", title: rss.stripHtml(title),
    url: `https://${id}.example/a`, excerpt: rss.stripHtml(excerpt),
    publishedAt: "2026-09-17T09:00:00Z", retrievedAt: "2026-09-17T12:00:00Z", via: "rss",
  });

  const background = [
    mk("bg1", "Outlet One", "New cat species identified in Bolivian forest", "Researchers described the first new wild cat species in over a century."),
    mk("bg2", "Outlet Two", "Swedish prime minister resigns after election loss", "Kristersson stepped down following his party's defeat at the polls."),
    mk("bg3", "Outlet Three", "Hague court sentences former president to 25 years", "Judges convicted the former president of war crimes at a tribunal."),
    mk("bg4", "Outlet Four", "Security council fails to adopt sanctions resolution", "Two permanent members vetoed the draft sanctions text."),
    mk("bg5", "Outlet Five", "Fed raises interest rates for the first time since 2023", "The central bank lifted its benchmark rate, citing persistent inflation."),
    mk("bg6", "Outlet Six", "Judge orders thirty days notice before demolition", "The order requires advance notice before any demolition work begins."),
  ];

  const pair = [
    mk("euobs", "EUobserver", "Canada&#8217;s Carney gets the red carpet treatment and EU &#8216;associate member&#8217; offer",
       "Carney was offered &#8216;associate member&#8217; status by the European Union in Strasbourg, with von der Leyen opening the door to closer ties."),
    mk("bsig", "Brussels Signal", "Carney welcomes EU &#8216;associate member&#8217; offer but leaves the terms to Brussels",
       "Carney welcomed the European Union&#8217;s associate member offer for Canada, leaving the terms to Brussels and von der Leyen."),
  ];

  const clusters = clusterItems([...background, ...pair], { windowHours: 72 });
  const joined = clusters.find(c => c.items.some(i => i.outletId === "euobs") && c.items.some(i => i.outletId === "bsig"));

  assert.ok(joined, "two outlets covering the same offer must cluster once entities are decoded");
  assert.ok(!JSON.stringify(joined.items).includes("&#"), "no entity artefacts may remain");
});

test("undecoded entities would have broken that same pair", () => {
  // The counterfactual, so this test proves decoding is what fixed it.
  const raw = "Canada&#8217;s Carney gets the red carpet treatment and EU &#8216;associate member&#8217; offer";
  const tokensRaw = tokenise(normaliseTitle(raw));
  const tokensClean = tokenise(normaliseTitle(rss.stripHtml(raw)));
  assert.ok(tokensRaw.some(t => /8217|8216/.test(t)), "raw entities leak numeric junk into the token stream");
  assert.ok(!tokensClean.some(t => /8217|8216/.test(t)), "decoded titles carry no entity junk");
  assert.ok(tokensClean.includes("canada") && tokensClean.includes("associate"), "real terms survive");
});
