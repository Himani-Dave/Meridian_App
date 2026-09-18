/**
 * Tests that run offline.
 *
 * None of these touch the network. They exist because the pipeline's dangerous
 * failures are quiet ones: a cluster that merges two stories and then claims
 * two-outlet corroboration, a view attributed to an outlet that did not cover
 * the story, a prose field that got filled in from a label. Each of those has a
 * test below.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { itemsFromFeed, _internals as rssInternals, EXCERPT_CHARS } from "../src/layers/discover-rss.js";
import { clusterItems, normaliseTitle, tokenise } from "../src/layers/cluster.js";
import { frameCluster, sideOf } from "../src/layers/frame.js";
import { buildCandidate, extractQuantities, findNumericConflicts } from "../src/bundle.js";
import { _internals as httpInternals } from "../src/http.js";
import { parseSeenDate, registrable } from "../src/layers/discover-gdelt.js";
import { RSS_2_0, ATOM, LONG_DESCRIPTION_RSS, MIXED_ITEMS, OFF_AXIS_ITEMS, OUTLETS, ROBOTS } from "./fixtures.js";

const parse = xml => rssInternals.parser.parse(xml);

// --- discovery -------------------------------------------------------------

test("RSS 2.0: CDATA titles, entities and HTML are handled", () => {
  const items = itemsFromFeed(parse(RSS_2_0), OUTLETS.northwind);
  assert.equal(items.length, 2, "the item with no link must be dropped");

  const [first, second] = items;
  assert.equal(first.title, "Harbour authority raises dock fees by 12% after budget vote");
  assert.match(first.excerpt, /^The harbour authority approved the increase on Tuesday\./);
  assert.ok(!first.excerpt.includes("<"), "HTML must be stripped from excerpts");
  assert.equal(first.publishedAt, "2026-09-16T08:15:00.000Z");

  assert.equal(second.excerpt, "Two operators said routes may be dropped & schedules thinned.");
  assert.equal(second.publishedAt, "2026-09-16T11:00:00.000Z", "dc:date must be read when pubDate is absent");
});

test("Atom: the alternate link is picked, not the first link", () => {
  const items = itemsFromFeed(parse(ATOM), OUTLETS.southport);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://southport.example/2026/09/dock-fee-rise");
  assert.ok(!items[0].url.includes("comments"));
});

test("excerpts stay short — the repo does not republish articles", () => {
  const items = itemsFromFeed(parse(LONG_DESCRIPTION_RSS), OUTLETS.northwind);
  assert.ok(items[0].excerpt.length <= EXCERPT_CHARS + 2, `excerpt was ${items[0].excerpt.length} chars`);
  assert.ok(items[0].excerpt.endsWith("…"));
});

test("GDELT date and domain helpers", () => {
  assert.equal(parseSeenDate("20260917T143000Z"), "2026-09-17T14:30:00Z");
  assert.equal(parseSeenDate("nonsense"), null);
  assert.equal(registrable("https://feeds.bbci.co.uk/news/rss.xml"), "bbci.co.uk");
  assert.equal(registrable("https://www.thehindu.com/x"), "thehindu.com");
});

// --- clustering ------------------------------------------------------------

test("titles lose their outlet tail before tokenising", () => {
  assert.equal(normaliseTitle("Dock fees rise 12% - Northwind Wire"), "Dock fees rise 12%");
  assert.ok(!tokenise("The council said that it was").includes("the"));
});

test("the same story from three outlets forms one cluster; the orchestra stays out", () => {
  const clusters = clusterItems(MIXED_ITEMS, { windowHours: 72 });
  const dockFees = clusters.find(c => c.items.some(i => i.url === "https://northwind.example/a"));

  assert.ok(dockFees, "dock fee story must cluster");
  assert.equal(dockFees.outletCount, 3, "three distinct outlets covered it");
  assert.ok(
    !dockFees.items.some(i => i.title.includes("orchestra")),
    "an unrelated story must not be merged in — over-merging fabricates corroboration"
  );

  const orchestra = clusters.find(c => c.items.some(i => i.title.includes("orchestra")));
  assert.equal(orchestra.items.length, 1);
  assert.equal(orchestra.outletCount, 1);
});

test("one outlet republishing itself is not corroboration", () => {
  const sameOutletOnly = MIXED_ITEMS.filter(i => i.outletId === "northwind");
  assert.equal(sameOutletOnly.length, 2);
  const clusters = clusterItems(sameOutletOnly, { windowHours: 72 });
  for (const c of clusters) {
    assert.equal(c.outletCount, 1, "outletCount must count distinct outlets, not articles");
  }
});

test("items outside the time window are not joined", () => {
  const stale = MIXED_ITEMS.map((i, n) =>
    n === 1 ? { ...i, publishedAt: "2026-08-01T09:00:00Z" } : i);
  const clusters = clusterItems(stale, { windowHours: 72 });
  const dockFees = clusters.find(c => c.items.some(i => i.url === "https://northwind.example/a"));
  assert.ok(!dockFees.items.some(i => i.url === "https://southport.example/b"));
});

// --- framing ---------------------------------------------------------------

test("lean maps to a side, and off-axis leans map to nothing", () => {
  assert.equal(sideOf("lean_left"), "left");
  assert.equal(sideOf("centre"), "centre");
  assert.equal(sideOf("right"), "right");
  assert.equal(sideOf("state"), null);
  assert.equal(sideOf("pro_sovereignty"), null);
});

test("a side nobody covered renders `not sourced`, never a synthesised view", () => {
  const clusters = clusterItems(MIXED_ITEMS, { windowHours: 72 });
  const dockFees = clusters.find(c => c.outletCount === 3);
  const { views } = frameCluster(dockFees);

  assert.equal(views.length, 3);
  for (const v of views) {
    assert.equal(v.text, null, "framing must never write view prose");
    if (v.outlets.length === 0) assert.equal(v.status, "not sourced");
    for (const o of v.outlets) {
      assert.ok(
        dockFees.items.some(i => i.outletId === o.outletId),
        "a view may only name an outlet that actually appears in the cluster"
      );
    }
  }
});

test("when only off-axis outlets cover a story, the left-right axis is marked inapplicable", () => {
  const clusters = clusterItems(OFF_AXIS_ITEMS, { windowHours: 72, threshold: 0.2 });
  const { axis, offAxis, views } = frameCluster(clusters[0]);

  assert.equal(axis.applies, false);
  assert.equal(axis.name, null, "the real axis must be named by a human, not guessed here");
  assert.ok(axis.reason.length > 0);
  assert.ok(offAxis.length >= 1);
  assert.ok(views.every(v => v.outlets.length === 0));
});

// --- conflicts and candidates ----------------------------------------------

test("numbers are extracted with their scale and subject", () => {
  const q = extractQuantities("The package is worth $20 million to operators and covers 12 percent of traffic.");
  const money = q.find(x => x.kind === "currency");
  const pct = q.find(x => x.kind === "percent");
  assert.equal(money.value, 20e6);
  assert.equal(pct.value, 12);
  assert.ok(money.subject.includes("million") || money.subject.includes("operators") || money.subject.includes("worth"));
});

test("a $20m vs $28m disagreement between two outlets is surfaced, not averaged", () => {
  const clusters = clusterItems(MIXED_ITEMS, { windowHours: 72 });
  const dockFees = clusters.find(c => c.outletCount === 3);
  const conflicts = findNumericConflicts(dockFees.items);

  assert.ok(conflicts.length >= 1, "the numeric disagreement must be detected");
  const values = conflicts[0].readings.map(r => r.value).join(" ");
  assert.match(values, /20|28/);
  assert.notEqual(conflicts[0].readings[0].outlet, conflicts[0].readings[1].outlet);
});

test("a candidate carries evidence and leaves every prose field null", () => {
  const roster = new Map(Object.values(OUTLETS).map(o => [o.id, o]));
  const clusters = clusterItems(MIXED_ITEMS, { windowHours: 72 });
  const dockFees = clusters.find(c => c.outletCount === 3);
  const candidate = buildCandidate(dockFees, roster);

  for (const field of ["headline", "context", "facts", "disputed", "coverage", "watch"]) {
    assert.equal(candidate[field], null, `${field} must not be generated by the pipeline`);
  }
  assert.equal(candidate.tier, "multi");
  assert.match(candidate.tierBasis, /3 outlets/);
  assert.equal(candidate.sources.length, dockFees.items.length);
  for (const s of candidate.sources) {
    assert.ok(s.u && s.t, "every source needs a url and the headline actually retrieved");
    assert.match(s.read, /headline/);
  }
  assert.equal(candidate.verification.attempted, false);
  assert.match(candidate.verification.reason, /no primary-document source mapped/);
});

test("a single-outlet cluster is labelled single, never promoted", () => {
  const roster = new Map(Object.values(OUTLETS).map(o => [o.id, o]));
  const clusters = clusterItems(MIXED_ITEMS, { windowHours: 72 });
  const orchestra = clusters.find(c => c.items.some(i => i.title.includes("orchestra")));
  const candidate = buildCandidate(orchestra, roster);
  assert.equal(candidate.tier, "single");
  assert.match(candidate.tierBasis, /1 source|single outlet/);
});

test("an MBFC rating without its link is not rendered as a rating", () => {
  const roster = new Map(Object.values(OUTLETS).map(o => [o.id, o]));
  roster.set("northwind", { ...OUTLETS.northwind, mbfc: { bias: "Left-Center", url: null } });
  const clusters = clusterItems(MIXED_ITEMS, { windowHours: 72 });
  const candidate = buildCandidate(clusters.find(c => c.outletCount === 3), roster);

  const northwind = candidate.sources.find(s => s.n === "Northwind Wire");
  assert.notEqual(northwind.b, "Left-Center", "rule 11: no MBFC link means no MBFC label");
  assert.equal(northwind.labelSource.provider, "roster");
});

// --- http politeness -------------------------------------------------------

test("robots.txt: the wildcard group applies and Allow beats Disallow", () => {
  const rules = httpInternals.parseRobots(ROBOTS);
  assert.equal(httpInternals.robotsAllows(rules, "/private/secret"), false);
  assert.equal(httpInternals.robotsAllows(rules, "/private/public-feed.xml"), true);
  assert.equal(httpInternals.robotsAllows(rules, "/news/rss.xml"), true);
});
