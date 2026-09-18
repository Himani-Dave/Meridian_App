/**
 * Regressions found by the first real ingestion run (2026-09-18).
 *
 * Both bugs here were invisible to the fixture-based tests and only appeared
 * against 642 real articles from 40 live feeds. Each one is now pinned.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { _internals as http, robotsPatternToRegex } from "../src/http.js";
import { isBoilerplate, clusterItems } from "../src/layers/cluster.js";

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
