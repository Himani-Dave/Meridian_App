/**
 * Region assignment and region-aware selection.
 *
 * The bug these replace: a story's region was taken from the nationality of
 * the outlets that covered it. The second real run therefore filed a Bolivian
 * wildlife story under Canada (the Globe and Mail ran it), the Kennedy Center
 * under Canada, and the Kosovo verdict under Canada and Europe — while not one
 * of twelve stories was about India, for an app built to brief on Canada,
 * India and Europe.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { regionsOf } from "../src/layers/region.js";
import { selectByRegion, parseQuotas } from "../src/select.js";

const cluster = (titles, { countries = [], excerpt = "" } = {}) => ({
  items: titles.map((title, i) => ({
    outletId: `o${i}`, outlet: `Outlet ${i}`, lean: "centre",
    country: countries[i] ?? "US", title, excerpt,
    url: `https://o${i}.example/a`, publishedAt: "2026-09-17T09:00:00Z",
  })),
  outletCount: titles.length,
  countries,
  similarity: { min: 0.5, max: 0.6, pairs: 1 },
});

// --- what a story is about -------------------------------------------------

test("a Canadian outlet covering a foreign story is not a Canada story", () => {
  const bolivia = cluster(
    ["New cat species identified in Bolivian forest, first in more than a century"],
    { countries: ["CA"] }
  );
  const { regions, scores } = regionsOf(bolivia);
  assert.ok(!regions.includes("Canada"),
    `filed as ${regions.join(",")} with Canada score ${scores.Canada} — publisher nationality must not decide subject`);
  assert.deepEqual(regions, ["Global"]);
});

test("a genuine Canada story is recognised from its subject", () => {
  const { regions, matched } = regionsOf(cluster(
    ["Canada welcomes EU proposal to become 'associate member'",
     "Carney speaks to the European Parliament in Strasbourg"],
    { countries: ["UK", "US"] }   // note: no Canadian outlet involved
  ));
  assert.ok(regions.includes("Canada"), "Canada and Carney in the text should place it");
  assert.ok(regions.includes("Europe"), "it is also a Europe story");
  assert.ok(matched.Canada.includes("canada"));
});

test("an India story is recognised even when only foreign outlets cover it", () => {
  const { regions } = regionsOf(cluster(
    ["India's Supreme Court rules on Delhi air quality measures",
     "Modi government defends new emissions rules in Lok Sabha"],
    { countries: ["UK", "QA"] }
  ));
  assert.ok(regions.includes("India"));
  assert.ok(!regions.includes("Canada"));
});

test("a single weak mention is not enough to claim a region", () => {
  const { regions, scores } = regionsOf(cluster(["Indian Ocean shipping rates climb after storm"]));
  assert.ok(!regions.includes("India"), `scored ${scores.India}; one weak demonym must not place a story`);
});

test("region assignment carries its own evidence", () => {
  const { matched } = regionsOf(cluster(["Swedish PM Kristersson resigns after election loss in Stockholm"]));
  assert.ok(matched.Europe?.length, "the matched terms must be recorded so a wrong call is auditable");
  assert.ok(matched.Europe.some(m => /sweden|stockholm/.test(m)));
});

// --- selection -------------------------------------------------------------

test("quotas are parsed, and bad entries ignored", () => {
  assert.deepEqual(parseQuotas("Canada=2,India=3"), { Canada: 2, India: 3 });
  assert.deepEqual(parseQuotas("Canada=2,broken"), { Canada: 2 });
});

test("a prolific region cannot take every slot", () => {
  const clusters = [
    ...Array.from({ length: 8 }, (_, i) =>
      cluster([`US Senate committee hearing number ${i} on federal policy`, "Washington debate continues"])),
    cluster(["Canada's Carney announces Ottawa infrastructure package", "Bank of Canada comments"]),
    cluster(["India's Lok Sabha passes new Delhi transport bill", "Modi government responds"]),
  ];

  const { selected, fill } = selectByRegion(clusters, { Canada: 1, India: 1, Global: 2 }, 4);
  const titles = selected.map(c => c.items[0].title).join(" | ");

  assert.equal(fill.Canada.filled, 1, "the Canada slot must be filled: " + titles);
  assert.equal(fill.India.filled, 1, "the India slot must be filled: " + titles);
  assert.ok(titles.includes("Carney"));
  assert.ok(titles.includes("Lok Sabha"));
});

test("an unfillable quota is reported, never backfilled from elsewhere", () => {
  const clusters = [
    cluster(["Canada's Carney announces Ottawa infrastructure package", "Bank of Canada comments"]),
    cluster(["Brussels agrees new European Commission budget line", "Von der Leyen speaks"]),
  ];

  const { fill } = selectByRegion(clusters, { Canada: 1, India: 3, Europe: 1 }, 12);

  assert.equal(fill.India.quota, 3);
  assert.equal(fill.India.filled, 0, "no India story exists, so none may be claimed");
  assert.equal(fill.India.availableInRegion, 0);
  assert.equal(fill.Canada.filled, 1);
  assert.equal(fill.Europe.filled, 1);
});

test("a story is never counted twice across regions", () => {
  const canadaEu = cluster(
    ["Canada welcomes EU proposal to become associate member", "Carney in Strasbourg meets von der Leyen"],
    { countries: ["CA", "EU"] }
  );
  const { selected } = selectByRegion([canadaEu], { Canada: 2, Europe: 2 }, 12);
  assert.equal(selected.length, 1, "one cluster counts once even when it satisfies two quotas");
});
