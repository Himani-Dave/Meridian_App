#!/usr/bin/env node
/**
 * validate-feeds.js — check every feed URL in config/sources.json.
 *
 * Each feed in the roster is a CONVENTIONAL GUESS marked "verified": false.
 * Several will be wrong or dead. This script finds out which, tries the common
 * fallbacks, and flips "verified" to true only on an actual successful fetch.
 *
 * The balance check at the end is the point. A silently missing right-leaning
 * feed reintroduces exactly the skew the roster exists to prevent, so this
 * exits non-zero when any lean bucket loses all its feeds.
 *
 * Usage:
 *   node scripts/validate-feeds.js                 # report only
 *   node scripts/validate-feeds.js --write         # update config/sources.json
 *   node scripts/validate-feeds.js --discover      # probe fallbacks for failures
 *
 * Requires Node 18+ (global fetch). No dependencies, no API keys.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ALTERNATES, HOMEPAGES, inspect, sniffAllFeeds } from "./feed-discovery.js";
import { sideOf } from "../backend/src/layers/frame.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(__dirname, "..", "config", "sources.json");
const REPORT = join(__dirname, "..", "config", "feed-report.md");

const WRITE    = process.argv.includes("--write");
const DISCOVER = process.argv.includes("--discover");

/**
 * ONE http client, shared with the ingestion pipeline.
 *
 * This file used to carry its own fetch: a different User-Agent, a 15s timeout,
 * six concurrent requests with no per-host gap, no retry, and — the damaging
 * one — no robots.txt check at all. The pipeline's client differs on every one
 * of those points.
 *
 * So "verified: true" meant "reachable by a client that does not exist in this
 * system", and that single divergence produced most of this project's failures:
 * fourteen feeds that validated and were then refused at ingest by robots.txt,
 * a Toronto Star url that passed with no retry and then 429'd, and 403s that
 * moved between runs because the two clients sent different agents.
 *
 * Validation must exercise the client that will do the reading. If this file
 * grows its own fetch again, test/integrity.test.js fails.
 */
import { get as politeGet } from "../backend/src/http.js";

const CONCURRENCY = 6;   // across hosts; http.js serialises per host itself

const FALLBACKS = [
  "/feed", "/feed/", "/rss", "/rss.xml", "/index.xml", "/atom.xml",
  // Patterns common on Indian news sites, which is where the gaps are.
  "/feed/rss", "/rss/", "/rssfeeds", "/?feed=rss2", "/feeds/posts/default",
  "/section/india/feed/", "/rss/india", "/latest/feed",
];

// ---------------------------------------------------------------------------

/** Adapt the pipeline client's result into the shape this script works in. */
async function get(url) {
  const res = await politeGet(url);
  if (res.ok) {
    return { ok: true, status: res.status, finalUrl: res.finalUrl, type: res.contentType ?? "", body: res.body };
  }
  return {
    ok: false,
    status: res.status ?? 0,
    finalUrl: res.finalUrl ?? url,
    type: "",
    body: "",
    blockedBy: res.blockedBy ?? null,
    // A robots refusal and an HTTP error are different facts and must read
    // differently in the report.
    error: res.blockedBy
      ? "refused by robots.txt — the ingest pipeline will refuse it too"
      : (res.error ?? `HTTP ${res.status ?? "?"}`),
  };
}

async function check(entry) {
  const result = { id: entry.id, name: entry.name, lean: entry.lean ?? null,
                   country: entry.country ?? entry.region ?? null,
                   url: entry.feed, ok: false, items: 0, note: "" };

  // Discovery writes here when it had to give up early. A failure that means
  // "we stopped looking" must never read like "there is nothing to find".
  const dnotes = [];

  if (!entry.feed) {
    result.note = "no feed url in roster";
    // With no url there is no origin to sniff, so a seed is the only way in.
    // `feed_index` is the outlet's own page listing its feeds — the best seed
    // there is, and better than any guess. (This previously read
    // `entry.homepage`, a field no roster entry has ever carried: the branch
    // was dead, so an outlet with no feed url could never be discovered.)
    const seed = entry.feed_index ?? ALTERNATES[entry.id]?.[0] ?? HOMEPAGES[entry.id];
    if (DISCOVER && seed) {
      const found = await discover(seed, null, entry.id, entry.feed_index, dnotes).catch(() => null);
      if (found) {
        result.ok = true; result.suggested = found.url; result.items = found.items;
        result.note = `had no url in the roster; found ${found.how}`;
      }
    }
    if (!result.ok && dnotes.length) result.note += ` [${dnotes.join("; ")}]`;
    return result;
  }

  try {
    const res = await get(entry.feed);
    if (!res.ok) {
      result.note = res.error;
      if (res.blockedBy) result.blockedBy = res.blockedBy;
      if (DISCOVER) {
        const found = await discover(entry.feed, null, entry.id, entry.feed_index, dnotes).catch(() => null);
        if (found) {
          result.ok = true; result.suggested = found.url; result.items = found.items;
          result.note = `original failed (${res.error}); found ${found.how}`;
        }
      }
      if (!result.ok && dnotes.length) result.note += ` [${dnotes.join("; ")}]`;
      return result;
    }
    const { isFeed, items } = inspect(res.body, res.type);

    if (res.status === 200 && isFeed) {
      result.ok = true;
      result.items = items;
      if (res.finalUrl !== entry.feed) { result.redirected = res.finalUrl; result.note = "redirected"; }
      if (items === 0) { result.ok = false; result.note = "parses as a feed but has 0 items"; }
      return result;
    }

    result.note = res.status !== 200 ? `HTTP ${res.status}`
                : isFeed ? "unexpected" : "200 but not a feed (probably an HTML page)";

    if (DISCOVER) {
      const found = await discover(entry.feed, res, entry.id, entry.feed_index, dnotes);
      if (found) { result.ok = true; result.suggested = found.url; result.items = found.items;
                   result.note = `original failed (${result.note}); found ${found.how}`; }
    }
  } catch (err) {
    result.note = String(err.message ?? err);
    if (DISCOVER) {
      try {
        const found = await discover(entry.feed, null, entry.id, entry.feed_index, dnotes);
        if (found) { result.ok = true; result.suggested = found.url; result.items = found.items;
                     result.note = `original failed (${result.note}); found ${found.how}`; }
      } catch { /* keep the original error */ }
    }
  }
  // Append the honest caveat to whatever verdict was reached, but only when
  // discovery did not succeed — a found feed makes the budget moot.
  if (!result.ok && dnotes.length) result.note += ` [${dnotes.join("; ")}]`;
  return result;
}

/** Try the site's homepage <link> tag, then common feed paths. */
/**
 * Discovery is now polite (one request per host at a time, 1.2s apart), so it
 * is also slow: ~15 requests per failing outlet. Bounded so a pathological
 * roster can never run the job into its timeout.
 */
/**
 * Enough budget to actually FINISH, instead of a number that guaranteed we
 * stopped early.
 *
 * This was 10. The steps want up to 1 original + 3 candidates + 3x3 sniffed +
 * 14 generic fallbacks = 35 probes, so any outlet that reached step 4 blew the
 * cap by construction. The first run after the honest-reporting change proved
 * it: the "stopped looking" note appeared on 16 of 17 failures. A caveat that
 * fires every time is not information, and the cap was not protecting anything
 * real — it was a proxy for runtime, chosen without measuring runtime.
 *
 * So the bound is now the thing it was always standing in for. 40 probes covers
 * every step to completion with headroom. The per-host gap in http.js is 1.2s
 * and probes for one outlet share a host, so a fully-failing outlet costs ~42s;
 * the 17 failing ones come to roughly 12 minutes inside a 30-minute job. The
 * time guard below is a hang-stopper for a pathological host, not the normal
 * limit — if it ever fires, that is worth seeing in the report.
 */
const MAX_PROBES_PER_OUTLET = 40;
const MAX_SECONDS_PER_OUTLET = 150;

/**
 * No single step may spend the whole probe budget.
 *
 * This was a real defect, and it is this project's signature failure wearing a
 * new coat. Steps 0, 2 and 3 each iterated sniffAllFeeds() output with no
 * bound, while attempt() quietly returned null once tried.size passed
 * MAX_PROBES_PER_OUTLET. A page declaring eight feeds therefore consumed the
 * entire budget, and every later step — including the homepage sniff, which the
 * comment below calls the one most likely to work — was skipped without ever
 * being attempted.
 *
 * The damage was not just the missed feed. attempt() returned null identically
 * whether a probe FAILED or was NEVER MADE, so the report said "no feed found"
 * when the truth was "we stopped looking". That is exactly the silent-no-op
 * class this project exists to eliminate. Each step now gets a bounded share,
 * and exhaustion is recorded and reported.
 */
const MAX_CANDIDATES_PER_STEP = 5;   // a bigger budget affords a wider look per step

async function discover(originalUrl, firstResponse, entryId = null, feedIndex = null, notes = []) {
  const origin = new URL(originalUrl).origin;
  const tried = new Set([originalUrl]);
  const startedAt = Date.now();
  let stopped = null;

  const attempt = async (candidate, how) => {
    if (!candidate || tried.has(candidate)) return null;
    // Both bounds are deliberately generous. Hitting either means we gave up
    // before exhausting the search, which must never read as "nothing exists".
    if (tried.size > MAX_PROBES_PER_OUTLET) {
      if (!stopped) notes.push(stopped = `gave up after ${tried.size - 1} probes (cap ${MAX_PROBES_PER_OUTLET}) — not all candidates were tried`);
      return null;
    }
    if ((Date.now() - startedAt) / 1000 > MAX_SECONDS_PER_OUTLET) {
      if (!stopped) notes.push(stopped = `gave up after ${MAX_SECONDS_PER_OUTLET}s on this host — not all candidates were tried`);
      return null;
    }
    tried.add(candidate);
    const r = await get(candidate).catch(() => null);
    if (!r?.ok) return null;
    const i = inspect(r.body, r.type);
    return i.isFeed && i.items > 0 ? { url: candidate, items: i.items, how } : null;
  };

  /** Probe a bounded share of what a page declared about itself. */
  const trySniffed = async (body, base, how) => {
    for (const candidate of sniffAllFeeds(body, base).slice(0, MAX_CANDIDATES_PER_STEP)) {
      const hit = await attempt(candidate, how);
      if (hit) return hit;
    }
    return null;
  };

  // 0. The outlet's own feed directory, if the roster names one. First,
  //    because it is the only source here that is not a guess — the publisher
  //    listing its own feeds beats any candidate we invented. Every wrong feed
  //    url in this project came from reasoning about what a url ought to be.
  if (feedIndex) {
    const page = await get(feedIndex).catch(() => null);
    if (page?.ok && page.body) {
      const hit = await trySniffed(page.body, new URL(feedIndex).origin,
        `listed on the outlet's feed index (${feedIndex})`);
      if (hit) return hit;
    }
  }

  // 1. Per-outlet candidates: specific guesses about a known outlet.
  for (const candidate of (ALTERNATES[entryId] ?? []).slice(0, MAX_CANDIDATES_PER_STEP)) {
    const hit = await attempt(candidate, "from the candidate list");
    if (hit) return hit;
  }

  // 2. What the failed page itself declared, if it returned HTML.
  if (firstResponse?.body && !/xml/i.test(firstResponse.type ?? "")) {
    const hit = await trySniffed(firstResponse.body, origin, "declared on the page that failed");
    if (hit) return hit;
  }

  // 3. Ask the homepage. This is the step that was missing entirely, and it is
  //    the one most likely to work: the outlet tells you where its feed is.
  const home = await get(origin + "/").catch(() => null);
  if (home?.ok && home.body) {
    const hit = await trySniffed(home.body, origin, "declared in the homepage <head>");
    if (hit) return hit;
  }

  // 4. Generic paths, last, because they are pure guesswork.
  for (const path of FALLBACKS) {
    const hit = await attempt(origin + path, `at ${path}`);
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pool(items, worker, limit) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) out[i] = await worker(items[i++]);
  }));
  return out;
}

// ---------------------------------------------------------------------------

const config = JSON.parse(await readFile(CONFIG, "utf8"));
const targets = [
  ...config.outlets.map(o => ({ ...o, _bucket: "outlets" })),
  ...config.primary.filter(p => p.feed).map(p => ({ ...p, _bucket: "primary" }))
];

console.log(`Checking ${targets.length} feeds${DISCOVER ? " (with fallback discovery)" : ""}...\n`);
const results = await pool(targets, check, CONCURRENCY);

const ok     = results.filter(r => r.ok);
const failed = results.filter(r => !r.ok);

for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  const extra = r.suggested ? `  -> USE: ${r.suggested}` : r.redirected ? `  -> ${r.redirected}` : "";
  console.log(`${mark}  ${String(r.name).padEnd(26)} ${r.ok ? `${r.items} items` : r.note}${extra}`);
}

// --- balance check: the guardrail, not a nicety --------------------------
const byLean = {};
for (const r of results.filter(r => r._bucket !== "primary" && r.lean)) {
  byLean[r.lean] ??= { total: 0, ok: 0 };
  byLean[r.lean].total++;
  if (r.ok) byLean[r.lean].ok++;
}

console.log(`\n${ok.length}/${results.length} feeds verified\n`);
console.log("Balance by lean (verified / total):");
/**
 * Only a SPECTRUM SIDE being empty is fatal.
 *
 * This bucketed by raw `lean` and failed on any empty bucket, which made adding
 * one unrated outlet (Times of India, no feed url yet) fail the whole run:
 * `unrated: 0/1` looked identical to "the right has gone silent". It is not the
 * same thing at all — one is a gap in our records about an outlet, the other is
 * the silent bias this check exists to catch.
 *
 * `state`, `varies`, `pro_sovereignty` and `unrated` are not sides of the
 * left-right axis, so they are reported and never fatal. The side mapping is
 * imported rather than restated — frame.js owns it, and a second copy here is
 * how the three duplicated-logic bugs in this project started.
 */
const bySide = { left: { total: 0, ok: 0 }, centre: { total: 0, ok: 0 }, right: { total: 0, ok: 0 } };
for (const r of results.filter(r => r._bucket !== "primary" && r.lean)) {
  const side = sideOf(r.lean);
  if (!side) continue;
  bySide[side].total++;
  if (r.ok) bySide[side].ok++;
}

const empty = [];
for (const [lean, c] of Object.entries(byLean).sort()) {
  const side = sideOf(lean);
  console.log(`  ${lean.padEnd(20)} ${c.ok}/${c.total}${side ? "" : "   (off-axis — reported, never fatal)"}`);
}
console.log("\nSpectrum sides (what the balance guarantee is about):");
for (const [side, c] of Object.entries(bySide)) {
  console.log(`  ${side.padEnd(20)} ${c.ok}/${c.total}`);
  if (c.ok === 0 && c.total > 0) empty.push(side);
}

const report = [
  `# Feed validation report`,
  ``,
  `Run: ${new Date().toISOString()}`,
  `Verified: ${ok.length}/${results.length}`,
  ``,
  `## Balance by lean`,
  ``,
  ...Object.entries(byLean).sort().map(([l, c]) => `- ${l}: ${c.ok}/${c.total} verified`),
  ``,
  `## Failures`,
  ``,
  ...(failed.length ? failed.map(r => `- **${r.name}** (${r.lean ?? r.country ?? "-"}) — ${r.note}${r.suggested ? ` — try \`${r.suggested}\`` : ""}\n  - tried: \`${r.url ?? "(none)"}\``) : ["None."]),
  ``,
  `## Redirects worth pinning`,
  ``,
  ...(ok.filter(r => r.redirected).map(r => `- **${r.name}**: \`${r.url}\` -> \`${r.redirected}\``) || ["None."])
].join("\n");

await writeFile(REPORT, report, "utf8");
console.log(`\nReport written to config/feed-report.md`);

if (WRITE) {
  const apply = list => list.map(e => {
    const r = results.find(x => x.id === e.id);
    if (!r) return e;
    const next = { ...e };
    if (r.ok) {
      next.verified = true;
      if (r.suggested) next.feed = r.suggested;
      if (r.redirected) next.feed = r.redirected;
      next.feed_checked = new Date().toISOString().slice(0, 10);
      next.feed_items = r.items ?? null;
      // A passing feed must not keep a failure note from an earlier run.
      // Haaretz and Focus Taiwan both carried verified:true alongside a stale
      // "HTTP 404", which is a record that contradicts itself.
      delete next.feed_error;
    } else {
      next.verified = false;
      next.feed_error = r.note;
      next.feed_checked = new Date().toISOString().slice(0, 10);
    }
    return next;
  });
  config.outlets = apply(config.outlets);
  config.primary = apply(config.primary);
  await writeFile(CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log("config/sources.json updated.");
} else {
  console.log("Dry run. Re-run with --write to update config/sources.json.");
}

if (empty.length) {
  console.error(`\nBALANCE FAILURE: no working feeds on the ${empty.join(" or ")} side of the spectrum`);
  console.error("Fix these before ingesting. A missing side is a silent bias, not a missing feature.");
  process.exit(1);
}
