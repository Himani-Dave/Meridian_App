/**
 * PREFLIGHT — run this first, and treat a failure here as a stop.
 *
 * Every other test file checks behaviour against invented data. This one checks
 * the things that have actually gone wrong in this project, which were never
 * behavioural bugs — they were two parts of the system quietly disagreeing with
 * each other, or a config value that looked fine and wasn't:
 *
 *   - validation used a different HTTP client from ingestion, so `verified:true`
 *     meant "reachable by a client that does not exist here". Fourteen feeds
 *     validated and were then refused at ingest by robots.txt.
 *   - a candidate URL was a search endpoint. It passed once, was written into
 *     the roster, then rate-limited.
 *   - candidate lists were keyed by outlet NAME while the roster keys by id, so
 *     three entries silently did nothing.
 *   - records carried `verified:true` alongside a stale `feed_error`.
 *
 * None of these are catchable by testing a function in isolation, and all of
 * them shipped. Each has a test here now.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ALTERNATES, HOMEPAGES, isSearchEndpoint } from "../../scripts/feed-discovery.js";
import { _internals as frame } from "../src/layers/frame.js";
import { _internals as region } from "../src/layers/region.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const read = rel => readFile(join(repo, rel), "utf8");
const roster = async () => JSON.parse(await read("config/sources.json"));

// === 1. ONE HTTP CLIENT =====================================================
// The root cause of most failures in this project. Asserted at source level,
// because the whole point is that a second client must never reappear.

test("the validator uses the pipeline's HTTP client, not its own", async () => {
  const src = await read("scripts/validate-feeds.js");

  assert.match(src, /from\s+["']\.\.\/backend\/src\/http\.js["']/,
    "validate-feeds.js must import the pipeline's client");
  assert.doesNotMatch(src, /^const UA\s*=/m,
    "a second User-Agent means validation tests a client that does not do the reading");
  assert.doesNotMatch(src, /await\s+fetch\s*\(/,
    "a bare fetch() bypasses robots.txt, the per-host gap and the retry policy");
  assert.doesNotMatch(src, /new AbortController/,
    "timeout handling belongs in one place");
});

test("only one module defines a User-Agent", async () => {
  const files = ["backend/src/http.js", "scripts/validate-feeds.js", "scripts/feed-discovery.js",
                 "backend/src/layers/discover-rss.js", "backend/src/layers/fetch-article.js"];
  const definers = [];
  for (const f of files) {
    if (/^const UA\s*=/m.test(await read(f))) definers.push(f);
  }
  assert.deepEqual(definers, ["backend/src/http.js"],
    `User-Agent defined in ${definers.length} places: ${definers.join(", ")}`);
});

// === 2. ROSTER INTEGRITY ====================================================

test("every outlet has the fields the pipeline reads", async () => {
  const { outlets } = await roster();
  for (const o of outlets) {
    for (const field of ["id", "name", "country", "lean", "funding"]) {
      assert.ok(o[field], `outlet ${o.id ?? o.name} is missing ${field}`);
    }
  }
});

test("outlet ids are unique", async () => {
  const { outlets, primary } = await roster();
  const ids = [...outlets, ...primary].map(e => e.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], [], "duplicate ids silently overwrite each other in the roster Map");
});

test("no feed url is a search endpoint", async () => {
  const { outlets } = await roster();
  for (const o of outlets.filter(o => o.feed)) {
    assert.equal(isSearchEndpoint(o.feed), false,
      `${o.name} has a search endpoint as its feed: ${o.feed} — it will rate-limit, and robots.txt "Disallow: /*?" forbids it`);
  }
});

test("every feed url is a well-formed https url", async () => {
  const { outlets } = await roster();
  for (const o of outlets.filter(o => o.feed)) {
    let u;
    assert.doesNotThrow(() => { u = new URL(o.feed); }, `${o.name}: unparseable feed url ${o.feed}`);
    assert.equal(u.protocol, "https:", `${o.name}: feed is not https (${o.feed})`);
  }
});

test("no record contradicts itself", async () => {
  const { outlets } = await roster();
  for (const o of outlets) {
    if (o.verified) {
      assert.ok(!o.feed_error,
        `${o.name} is verified:true but still carries feed_error "${o.feed_error}" from an earlier run`);
      assert.ok(o.feed, `${o.name} is verified:true with no feed url`);
    }
  }
});

// === 3. LEAN VALUES THE FRAMING LAYER ACTUALLY KNOWS ========================
// An unrecognised lean does not error — it quietly lands in offAxis, so the
// outlet silently stops counting toward any side of the spectrum.

test("every lean in the roster is known to the framing layer", async () => {
  const { outlets } = await roster();
  const known = new Set([...Object.keys(frame.SIDE_OF_LEAN), ...frame.OFF_AXIS_LEANS]);
  const unknown = [...new Set(outlets.map(o => o.lean))].filter(l => !known.has(String(l).toLowerCase()));
  assert.deepEqual(unknown, [],
    `these leans are silently treated as off-axis: ${unknown.join(", ")}`);
});

test("each spectrum side has more than one outlet in the roster", async () => {
  const { outlets } = await roster();
  const counts = { left: 0, centre: 0, right: 0 };
  for (const o of outlets) {
    const side = frame.SIDE_OF_LEAN[String(o.lean).toLowerCase()];
    if (side) counts[side]++;
  }
  for (const [side, n] of Object.entries(counts)) {
    assert.ok(n >= 2, `only ${n} outlet(s) on the ${side} — one failure would silence that side entirely`);
  }
});

// === 4. CANDIDATE LISTS =====================================================

test("candidate and homepage lists key to real roster ids", async () => {
  const { outlets, primary } = await roster();
  const ids = new Set([...outlets, ...primary].map(e => e.id));
  for (const key of [...Object.keys(ALTERNATES), ...Object.keys(HOMEPAGES)]) {
    assert.ok(ids.has(key),
      `"${key}" matches no roster id, so every url under it does nothing at all`);
  }
});

test("no candidate or homepage url is a search endpoint", () => {
  for (const [id, urls] of Object.entries(ALTERNATES)) {
    for (const u of urls) assert.equal(isSearchEndpoint(u), false, `ALTERNATES.${id}: ${u}`);
  }
  for (const [id, u] of Object.entries(HOMEPAGES)) {
    assert.equal(isSearchEndpoint(u), false, `HOMEPAGES.${id}: ${u}`);
  }
});

test("every candidate and homepage url parses", () => {
  const all = [...Object.values(ALTERNATES).flat(), ...Object.values(HOMEPAGES)];
  for (const u of all) assert.doesNotThrow(() => new URL(u), `unparseable candidate: ${u}`);
});

// === 5. REGION GAZETTEER ====================================================

test("no gazetteer term claims two regions at once", () => {
  const seen = new Map();
  for (const bucket of [region.STRONG, region.WEAK]) {
    for (const [reg, terms] of Object.entries(bucket)) {
      for (const term of terms) {
        const prior = seen.get(term);
        assert.ok(!prior || prior === reg,
          `"${term}" is listed under both ${prior} and ${reg} — it would score a story for both`);
        seen.set(term, reg);
      }
    }
  }
});

test("gazetteer terms are lowercase, since matching lowercases the text", () => {
  for (const bucket of [region.STRONG, region.WEAK]) {
    for (const terms of Object.values(bucket)) {
      for (const term of terms) {
        assert.equal(term, term.toLowerCase(), `"${term}" will never match`);
      }
    }
  }
});

// === 6. THE WORKFLOW ========================================================
// A green check on a run that did nothing is the failure mode this project
// exists to prevent, and it happened three times.

test("the workflow cannot report success without doing work", async () => {
  let wf;
  try { wf = await read(".github/workflows/meridian.yml"); }
  catch { return; }   // not present in every checkout

  assert.match(wf, /Refuse to pass a run that did nothing/,
    "a run where both jobs are skipped must fail, not pass");
  assert.match(wf, /produced nothing to commit/,
    "a run that commits nothing must say so loudly");
  assert.doesNotMatch(wf, /git add -A config\/sources\.json config\/feed-report\.md backend\/data/,
    "multi-pathspec `git add` fails atomically and silently discards every result");
});
